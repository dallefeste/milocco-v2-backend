import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DeepPartial, Repository } from 'typeorm';
import { CrudService } from '../../common/crud/crud.service';
import { Customer, Department, ExtraActivity, Finish, MachineType, Material, StopReason, Supplier, Treatment } from '../../entities';
import { assertNotUsed, plural } from './masterdata.common';

/** Anagrafiche semplici: CRUD generico più i controlli prima dell'eliminazione. */

@Injectable()
export class CustomersService extends CrudService<Customer> {
  constructor(@InjectRepository(Customer) repo: Repository<Customer>) {
    super(repo, { label: 'Cliente', searchFields: ['name', 'notes'], defaultSort: { field: 'name', order: 'asc' } });
  }

  async remove(id: number): Promise<void> {
    await this.findOne(id);
    await assertNotUsed(this.repo.manager, [
      {
        sql: 'SELECT 1 FROM customer_order WHERE customer_id = $1 AND deleted_at IS NULL',
        params: [id],
        message: (n) => `Il cliente ha ${plural(n, 'ordine cliente', 'ordini cliente')}: non si può eliminare.`,
      },
      {
        sql: 'SELECT 1 FROM quote WHERE customer_id = $1 AND deleted_at IS NULL',
        params: [id],
        message: (n) => `Il cliente ha ${plural(n, 'preventivo', 'preventivi')}: non si può eliminare.`,
      },
    ]);
    await super.remove(id);
  }
}

@Injectable()
export class SuppliersService extends CrudService<Supplier> {
  constructor(@InjectRepository(Supplier) repo: Repository<Supplier>) {
    super(repo, { label: 'Fornitore', searchFields: ['name', 'notes'], defaultSort: { field: 'name', order: 'asc' } });
  }

  async remove(id: number): Promise<void> {
    await this.findOne(id);
    await assertNotUsed(this.repo.manager, [{
      sql: 'SELECT 1 FROM part WHERE supplier_id = $1 AND deleted_at IS NULL',
      params: [id],
      message: (n) => `Il fornitore è indicato in ${plural(n, 'particolare', 'particolari')}: non si può eliminare.`,
    }]);
    await super.remove(id);
  }
}

@Injectable()
export class DepartmentsService extends CrudService<Department> {
  constructor(@InjectRepository(Department) repo: Repository<Department>) {
    super(repo, { label: 'Reparto', searchFields: ['name'], defaultSort: { field: 'name', order: 'asc' } });
  }

  async remove(id: number): Promise<void> {
    await this.findOne(id);
    await assertNotUsed(this.repo.manager, [{
      sql: 'SELECT 1 FROM operator WHERE department_id = $1 AND deleted_at IS NULL',
      params: [id],
      message: (n) => (n === 1 ? "Nel reparto c'è 1 operatore: spostalo" : `Nel reparto ci sono ${n} operatori: spostali`) + ' in un altro reparto prima di eliminarlo.',
    }]);
    await super.remove(id);
  }
}

@Injectable()
export class MachineTypesService extends CrudService<MachineType> {
  constructor(@InjectRepository(MachineType) repo: Repository<MachineType>) {
    super(repo, {
      label: 'Tipologia macchina',
      searchFields: ['name', 'excelColumn'],
      defaultSort: { field: 'sortOrder', order: 'asc' },
    });
  }

  async remove(id: number): Promise<void> {
    await this.findOne(id);
    await assertNotUsed(this.repo.manager, [
      {
        sql: 'SELECT 1 FROM machine WHERE machine_type_id = $1 AND deleted_at IS NULL',
        params: [id],
        message: (n) => `La tipologia è assegnata a ${plural(n, 'macchina', 'macchine')}: non si può eliminare.`,
      },
      {
        sql: `SELECT 1 FROM part_cycle_step s JOIN part p ON p.id = s.part_id
              WHERE s.machine_type_id = $1 AND p.deleted_at IS NULL`,
        params: [id],
        message: (n) => `La tipologia compare nel ciclo di lavorazione di ${plural(n, 'particolare', 'particolari')}: non si può eliminare.`,
      },
    ]);
    await super.remove(id);
  }
}

@Injectable()
export class MaterialsService extends CrudService<Material> {
  constructor(@InjectRepository(Material) repo: Repository<Material>) {
    super(repo, { label: 'Materiale', searchFields: ['name', 'code'], defaultSort: { field: 'name', order: 'asc' } });
  }

  private async assertCodeFree(code: string | null | undefined, exceptId?: number): Promise<void> {
    if (!code) return;
    const other = await this.repo.createQueryBuilder('m')
      .where('upper(m.code) = :code', { code: code.toUpperCase() })
      .andWhere(exceptId ? 'm.id <> :id' : '1=1', { id: exceptId })
      .getOne();
    if (other) throw new ConflictException(`Il codice ${code} è già usato dal materiale "${other.name}".`);
  }

  async create(data: DeepPartial<Material>): Promise<Material> {
    await this.assertCodeFree(data.code as string | null | undefined);
    return super.create(data);
  }

  async update(id: number, data: DeepPartial<Material>): Promise<Material> {
    const current = await this.findOne(id);
    if (data.code !== undefined && (data.code ?? null) !== (current.code ?? null)) {
      await this.assertCodeFree(data.code as string | null, id);
      await assertNotUsed(this.repo.manager, [{
        sql: 'SELECT 1 FROM bar_type WHERE material_id = $1 AND deleted_at IS NULL',
        params: [id],
        message: (n) => `Il codice fa parte del codice articolo di ${plural(n, 'tipologia barra', 'tipologie barre')}: non si può cambiare.`,
      }]);
    }
    return super.update(id, data);
  }

  async remove(id: number): Promise<void> {
    await this.findOne(id);
    await assertNotUsed(this.repo.manager, [
      {
        sql: 'SELECT 1 FROM part WHERE material_id = $1 AND deleted_at IS NULL',
        params: [id],
        message: (n) => `Il materiale è usato in ${plural(n, 'particolare', 'particolari')}: non si può eliminare.`,
      },
      {
        sql: 'SELECT 1 FROM bar_type WHERE material_id = $1 AND deleted_at IS NULL',
        params: [id],
        message: (n) => `Il materiale è usato in ${plural(n, 'tipologia barra', 'tipologie barre')}: non si può eliminare.`,
      },
    ]);
    await super.remove(id);
  }
}

@Injectable()
export class FinishesService extends CrudService<Finish> {
  constructor(@InjectRepository(Finish) repo: Repository<Finish>) {
    super(repo, { label: 'Finitura', searchFields: ['name', 'code'], defaultSort: { field: 'code', order: 'asc' } });
  }

  async create(data: DeepPartial<Finish>): Promise<Finish> {
    const other = await this.repo.findOne({ where: { code: data.code as string } });
    if (other) throw new ConflictException(`Il codice ${data.code} è già usato dalla finitura "${other.name}".`);
    return super.create(data);
  }

  async update(id: number, data: DeepPartial<Finish>): Promise<Finish> {
    const current = await this.findOne(id);
    if (data.code !== undefined && data.code !== current.code) {
      throw new BadRequestException('Il codice della finitura non si può modificare dopo la creazione.');
    }
    return super.update(id, data);
  }

  async remove(id: number): Promise<void> {
    await this.findOne(id);
    await assertNotUsed(this.repo.manager, [{
      sql: 'SELECT 1 FROM bar_type WHERE finish_id = $1 AND deleted_at IS NULL',
      params: [id],
      message: (n) => `La finitura è usata in ${plural(n, 'tipologia barra', 'tipologie barre')}: non si può eliminare.`,
    }]);
    await super.remove(id);
  }
}

@Injectable()
export class TreatmentsService extends CrudService<Treatment> {
  constructor(@InjectRepository(Treatment) repo: Repository<Treatment>) {
    super(repo, { label: 'Trattamento', searchFields: ['name'], defaultSort: { field: 'name', order: 'asc' } });
  }

  async remove(id: number): Promise<void> {
    await this.findOne(id);
    await assertNotUsed(this.repo.manager, [
      {
        sql: `SELECT 1 FROM drawing_treatment dt JOIN drawing d ON d.id = dt.drawing_id
              WHERE dt.treatment_id = $1 AND d.deleted_at IS NULL`,
        params: [id],
        message: (n) => `Il trattamento è previsto in ${plural(n, 'disegno', 'disegni')}: non si può eliminare.`,
      },
      {
        sql: `SELECT 1 FROM production_order_treatment t JOIN production_order o ON o.id = t.production_order_id
              WHERE t.treatment_id = $1 AND o.deleted_at IS NULL AND o.status <> 'COMPLETED'`,
        params: [id],
        message: (n) => `Il trattamento è previsto in ${plural(n, 'ordine di produzione non completato', 'ordini di produzione non completati')}: non si può eliminare.`,
      },
    ]);
    await super.remove(id);
  }
}

@Injectable()
export class StopReasonsService extends CrudService<StopReason> {
  constructor(@InjectRepository(StopReason) repo: Repository<StopReason>) {
    super(repo, { label: 'Causale di fermo', searchFields: ['name', 'description'], defaultSort: { field: 'sortOrder', order: 'asc' } });
  }

  async remove(id: number): Promise<void> {
    await this.findOne(id);
    await assertNotUsed(this.repo.manager, [{
      sql: 'SELECT 1 FROM work_stop WHERE stop_reason_id = $1 AND ended_at IS NULL AND deleted_at IS NULL',
      params: [id],
      message: () => 'C\'è un fermo in corso con questa causale: si potrà eliminare quando il fermo sarà chiuso.',
    }]);
    await super.remove(id);
  }
}

@Injectable()
export class ExtraActivitiesService extends CrudService<ExtraActivity> {
  constructor(@InjectRepository(ExtraActivity) repo: Repository<ExtraActivity>) {
    super(repo, { label: 'Lavoro extra', searchFields: ['name'], defaultSort: { field: 'name', order: 'asc' } });
  }

  async remove(id: number): Promise<void> {
    await this.findOne(id);
    await assertNotUsed(this.repo.manager, [{
      sql: 'SELECT 1 FROM extra_activity_log WHERE extra_activity_id = $1 AND ended_at IS NULL AND deleted_at IS NULL',
      params: [id],
      message: () => 'Un operatore ha in corso questo lavoro extra: si potrà eliminare quando sarà concluso.',
    }]);
    await super.remove(id);
  }
}
