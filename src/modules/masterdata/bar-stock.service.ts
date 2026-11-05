import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { BAR_MOVEMENT_KIND_LABELS, type BarMovementKind } from '../../shared';
import { writeAudit } from '../../common/crud/crud.service';
import { ListQueryDto, Paginated } from '../../common/crud/list-query.dto';
import { currentUser } from '../../common/context/request-context';
import { BarStock, BarStockMovement, BarType } from '../../entities';
import { User } from '../users/user.entity';

export interface BarMovementOptions {
  /** Operatore di reparto che ha fatto il movimento (tablet). */
  operatorId?: number | null;
  /** Utente del gestionale; se assente quello della richiesta corrente. */
  userId?: number | null;
  productionOrderId?: number | null;
  reason?: string | null;
  /** Transazione del chiamante: il movimento si salva dentro di essa (e si annulla con essa). */
  manager?: EntityManager;
}

export interface BarMovementResult {
  movementId: number;
  barTypeId: number;
  code: string;
  kind: BarMovementKind;
  /** Variazione con segno (carico +, scarico −, rettifica = differenza). */
  delta: number;
  metersBefore: number;
  metersAfter: number;
  /** Avviso da mostrare (giacenza negativa): non blocca il movimento. */
  warnings: string[];
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;
const fmtM = (n: number) => `${n.toLocaleString('it-IT', { maximumFractionDigits: 3 })} m`;

/**
 * Magazzino barre: giacenza in metri lineari per tipologia, con storico dei movimenti.
 * Esportato dal modulo: il tablet (taglio) e la coda di taglio usano load/unload/getMeters.
 * La giacenza si gestisce solo qui (carichi, scarichi e rettifiche dal gestionale e dal tablet).
 */
@Injectable()
export class BarStockService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(BarStock) private readonly stocks: Repository<BarStock>,
    @InjectRepository(BarStockMovement) private readonly movements: Repository<BarStockMovement>,
    @InjectRepository(BarType) private readonly barTypes: Repository<BarType>,
  ) {}

  /** Metri disponibili di una tipologia (0 se mai caricata). */
  async getMeters(barTypeId: number): Promise<number> {
    const row = await this.stocks.findOne({ where: { barTypeId } });
    return row ? Number(row.meters) : 0;
  }

  /** Metri disponibili per tutte le tipologie (o quelle indicate): mappa id tipologia → metri. */
  async getMetersMap(barTypeIds?: number[]): Promise<Map<number, number>> {
    const qb = this.stocks.createQueryBuilder('s');
    if (barTypeIds) {
      if (barTypeIds.length === 0) return new Map();
      qb.where('s.barTypeId IN (:...ids)', { ids: barTypeIds });
    }
    return new Map((await qb.getMany()).map((s) => [s.barTypeId, Number(s.meters)]));
  }

  load(barTypeId: number, meters: number, opts: BarMovementOptions = {}) {
    return this.move('LOAD', barTypeId, meters, opts);
  }

  unload(barTypeId: number, meters: number, opts: BarMovementOptions = {}) {
    return this.move('UNLOAD', barTypeId, meters, opts);
  }

  /** Rettifica: imposta la giacenza al valore indicato (inventario). */
  adjust(barTypeId: number, newMeters: number, opts: BarMovementOptions = {}) {
    return this.move('ADJUST', barTypeId, newMeters, opts);
  }

  private async move(kind: BarMovementKind, barTypeId: number, value: number, opts: BarMovementOptions): Promise<BarMovementResult> {
    if (!Number.isFinite(value) || value < 0) throw new BadRequestException('Valore negativo o non valido');
    const work = async (em: EntityManager) => {
      const barType = await em.findOne(BarType, { where: { id: barTypeId } });
      if (!barType) throw new NotFoundException(`Tipologia barra non trovata (id ${barTypeId})`);
      await em.query('INSERT INTO bar_stock (bar_type_id, meters) VALUES ($1, 0) ON CONFLICT (bar_type_id) DO NOTHING', [barTypeId]);
      const stock = await em.createQueryBuilder(BarStock, 's').setLock('pessimistic_write').where('s.barTypeId = :barTypeId', { barTypeId }).getOneOrFail();
      const before = Number(stock.meters);
      const after = round3(kind === 'LOAD' ? before + value : kind === 'UNLOAD' ? before - value : value);
      const delta = round3(after - before);
      stock.meters = after;
      await em.save(stock);
      const movement = await em.save(em.create(BarStockMovement, {
        barTypeId,
        kind,
        meters: delta,
        metersAfter: after,
        reason: opts.reason ?? null,
        productionOrderId: opts.productionOrderId ?? null,
        operatorId: opts.operatorId ?? null,
        userId: opts.userId !== undefined ? opts.userId : (currentUser().userId ?? null),
      }));
      await writeAudit(em, 'bar_stock', 'ACTION', barTypeId, { kind, delta, metersAfter: after, reason: opts.reason ?? null },
        `${BAR_MOVEMENT_KIND_LABELS[kind]} ${barType.code}: ${fmtM(delta)} → ${fmtM(after)}`);
      return { barType, movement, before, after, delta };
    };

    const r = opts.manager ? await work(opts.manager) : await this.dataSource.transaction(work);
    const warnings: string[] = [];
    if (r.after < 0) warnings.push(`Attenzione: la giacenza di ${r.barType.code} è negativa (${fmtM(r.after)}). Controlla il magazzino e fai una rettifica.`);
    return {
      movementId: r.movement.id,
      barTypeId,
      code: r.barType.code,
      kind,
      delta: r.delta,
      metersBefore: r.before,
      metersAfter: r.after,
      warnings,
    };
  }

  // ------------------------------------------------------------ storico movimenti

  async listMovements(query: ListQueryDto): Promise<Paginated<BarStockMovement>> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 25;
    const qb = this.movements.createQueryBuilder('m')
      .leftJoinAndSelect('m.barType', 'barType')
      .leftJoinAndSelect('barType.material', 'material')
      .leftJoinAndSelect('m.operator', 'operator')
      .leftJoinAndMapOne('m.user', User, 'user', 'user.id = m.userId');
    const f = query.filter ?? {};
    if (f.barTypeId) qb.andWhere('m.barTypeId = :bt', { bt: Number(f.barTypeId) });
    if (f.kind) qb.andWhere('m.kind IN (:...kinds)', { kinds: f.kind.split(',') });
    if (f.operatorId) qb.andWhere('m.operatorId = :op', { op: Number(f.operatorId) });
    if (f.productionOrderId) qb.andWhere('m.productionOrderId = :po', { po: Number(f.productionOrderId) });
    if (query.search) {
      qb.andWhere('(barType.code ILIKE :s OR m.reason ILIKE :s OR user.username ILIKE :s OR operator.lastName ILIKE :s)', { s: `%${query.search.trim()}%` });
    }
    const sortMap: Record<string, string> = { createdAt: 'm.createdAt', meters: 'm.meters', kind: 'm.kind', 'barType.code': 'barType.code' };
    qb.orderBy(sortMap[query.sort ?? ''] ?? 'm.createdAt', query.sort && query.order === 'asc' ? 'ASC' : 'DESC').addOrderBy('m.id', 'DESC');
    const [items, total] = await qb.skip((page - 1) * pageSize).take(pageSize).getManyAndCount();
    // Dell'utente servono solo i nomi
    for (const it of items as (BarStockMovement & { user?: Partial<User> | null })[]) {
      if (it.user) it.user = { id: it.user.id, username: it.user.username, firstName: it.user.firstName, lastName: it.user.lastName };
    }
    return { items, total, page, pageSize };
  }

  /** Riepilogo per l'intestazione della pagina Magazzino barre. */
  async summary() {
    const [row] = await this.dataSource.query(`
      SELECT count(*) FILTER (WHERE t.deleted_at IS NULL) AS types,
             count(s.id) FILTER (WHERE t.deleted_at IS NULL AND s.meters > 0) AS available,
             count(s.id) FILTER (WHERE t.deleted_at IS NULL AND s.meters < 0) AS negative
      FROM bar_type t LEFT JOIN bar_stock s ON s.bar_type_id = t.id`);
    return {
      types: Number(row.types),
      available: Number(row.available),
      negative: Number(row.negative),
    };
  }
}
