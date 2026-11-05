import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcryptjs';
import { Repository, SelectQueryBuilder } from 'typeorm';
import { CrudService, writeAudit } from '../../common/crud/crud.service';
import { ListQueryDto, Paginated } from '../../common/crud/list-query.dto';
import { Operator } from '../../entities';
import { assertNotUsed } from './masterdata.common';

/** Operatore come esce dall'API: il PIN non viene mai restituito, solo se è impostato. */
export type OperatorView = Omit<Operator, 'pinHash'> & { hasPin: boolean };

@Injectable()
export class OperatorsService extends CrudService<Operator> {
  constructor(@InjectRepository(Operator) repo: Repository<Operator>) {
    super(repo, {
      label: 'Operatore',
      relations: ['department'],
      searchFields: ['firstName', 'lastName', 'badgeNumber', 'department.name'],
      sortable: ['firstName', 'lastName', 'badgeNumber', 'department.name', 'active', 'hireDate', 'birthDate', 'createdAt'],
      filterable: ['departmentId', 'active', 'department.isProduction'],
      defaultSort: { field: 'lastName', order: 'asc' },
    });
  }

  /** Carica anche l'hash del PIN, solo per calcolare `hasPin`. */
  protected baseQuery(withDeleted = false): SelectQueryBuilder<Operator> {
    return super.baseQuery(withDeleted).addSelect(`${this.alias}.pinHash`);
  }

  static toView(op: Operator): OperatorView {
    const { pinHash, ...rest } = op;
    return { ...rest, hasPin: !!pinHash };
  }

  async listView(query: ListQueryDto): Promise<Paginated<OperatorView>> {
    const res = await this.list(query);
    return { ...res, items: res.items.map(OperatorsService.toView) };
  }

  async getView(id: number): Promise<OperatorView> {
    return OperatorsService.toView(await this.findOne(id));
  }

  async remove(id: number): Promise<void> {
    await this.findOne(id);
    await assertNotUsed(this.repo.manager, [{
      sql: `SELECT 1 FROM work_phase WHERE operator_id = $1 AND status = 'IN_PROGRESS' AND deleted_at IS NULL
            UNION ALL SELECT 1 FROM inspection WHERE operator_id = $1 AND ended_at IS NULL AND deleted_at IS NULL
            UNION ALL SELECT 1 FROM extra_activity_log WHERE operator_id = $1 AND ended_at IS NULL AND deleted_at IS NULL`,
      params: [id],
      message: () => "L'operatore ha attività in corso sul tablet: si potrà eliminare quando saranno chiuse. In alternativa rendilo non attivo.",
    }]);
    await super.remove(id);
  }

  /** Imposta (o sostituisce) il PIN del tablet. Nel database resta solo l'hash. */
  async setPin(id: number, pin: string): Promise<OperatorView> {
    await this.findOne(id);
    await this.repo.update(id, { pinHash: await bcrypt.hash(pin, 10) });
    await writeAudit(this.repo.manager, 'operator', 'ACTION', id, null, 'PIN tablet impostato');
    return this.getView(id);
  }

  /** Toglie il PIN: sul tablet l'operatore si sceglie dall'elenco senza PIN. */
  async clearPin(id: number): Promise<OperatorView> {
    await this.findOne(id);
    await this.repo.update(id, { pinHash: null });
    await writeAudit(this.repo.manager, 'operator', 'ACTION', id, null, 'PIN tablet azzerato');
    return this.getView(id);
  }

  /**
   * Verifica il PIN di un operatore (per il tablet). Ritorna true anche se l'operatore non ha un PIN impostato.
   * Operatori eliminati o non attivi: sempre false.
   */
  async verifyPin(id: number, pin: string | null | undefined): Promise<boolean> {
    const op = await this.repo.createQueryBuilder('o').addSelect('o.pinHash').where('o.id = :id', { id }).getOne();
    if (!op || !op.active) return false;
    if (!op.pinHash) return true;
    return !!pin && bcrypt.compare(pin, op.pinHash);
  }
}
