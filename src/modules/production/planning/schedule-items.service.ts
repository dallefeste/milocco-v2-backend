import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Repository, SelectQueryBuilder } from 'typeorm';
import { CrudService, writeAudit } from '../../../common/crud/crud.service';
import { ListQueryDto, Paginated } from '../../../common/crud/list-query.dto';
import { Machine, PartCycleStep, ProductionOrder, ScheduleItem } from '../../../entities';
import { effectiveStatusSql, lockQueue, renumberMachine } from '../common/production-db';
import { provisionalPosition } from '../common/queue-rules';
import { ProductionOrdersService } from '../orders/production-orders.service';
import { BulkCreateScheduleItemsDto, CreateScheduleItemDto, ScheduleTimesDto, UpdateScheduleItemDto } from './schedule.dto';

const LABEL = 'Lavorazione pianificata';

export type ScheduleItemWithStatus = ScheduleItem & { effectiveStatus: 'OPEN' | 'IN_PROGRESS' | 'DONE' };

@Injectable()
export class ScheduleItemsService extends CrudService<ScheduleItem> {
  constructor(
    @InjectRepository(ScheduleItem) repo: Repository<ScheduleItem>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly orders: ProductionOrdersService,
  ) {
    super(repo, {
      label: LABEL,
      relations: ['productionOrder', 'productionOrder.drawing', 'productionOrder.customerOrder', 'productionOrder.customerOrder.customer', 'part', 'machine'],
      searchFields: ['productionOrderId', 'part.internalCode', 'part.name', 'machine.name', 'productionOrder.drawing.code', 'productionOrder.customerOrder.code', 'productionOrder.customerOrder.customer.name'],
      sortable: ['id', 'productionOrderId', 'machine.name', 'part.internalCode', 'position', 'quantity', 'setupSeconds', 'unitSeconds', 'createdAt', 'productionOrder.expectedDeliveryDate'],
      filterable: ['machineId', 'productionOrderId', 'partId'],
      defaultSort: { field: 'createdAt', order: 'desc' },
    });
  }

  /** Filtri speciali: `status` (ACTIVE = non concluse, oppure OPEN/IN_PROGRESS/DONE separati da virgola), `customerId`. */
  protected override customizeList(qb: SelectQueryBuilder<ScheduleItem>, query: ListQueryDto): void {
    qb.andWhere('productionOrder.deletedAt IS NULL');
    const f = query.filter ?? {};
    const eff = effectiveStatusSql('e', 'productionOrder');
    if (f.status === 'ACTIVE') qb.andWhere(`${eff} <> 'DONE'`);
    else if (f.status) qb.andWhere(`${eff} IN (:...st)`, { st: f.status.split(',') });
    if (f.customerId) qb.andWhere('productionOrder_customerOrder.customerId = :cid', { cid: Number(f.customerId) });
  }

  override async list(query: ListQueryDto): Promise<Paginated<ScheduleItem>> {
    const res = await super.list(query);
    return { ...res, items: await this.withStatus(this.repo.manager, res.items) };
  }

  async get(id: number): Promise<ScheduleItemWithStatus> {
    const [item] = await this.withStatus(this.repo.manager, [await this.findOne(id)]);
    return item;
  }

  /** Aggiunge lo stato effettivo (vedi effectiveStatusSql). */
  async withStatus(em: EntityManager, items: ScheduleItem[]): Promise<ScheduleItemWithStatus[]> {
    if (!items.length) return [];
    const rows: { id: number; eff: ScheduleItemWithStatus['effectiveStatus'] }[] = await em.query(
      `SELECT si.id, ${effectiveStatusSql()} AS eff FROM schedule_item si JOIN production_order po ON po.id = si.production_order_id WHERE si.id = ANY($1)`,
      [items.map((i) => i.id)],
    );
    const map = new Map(rows.map((r) => [r.id, r.eff]));
    return items.map((i) => Object.assign(i, { effectiveStatus: map.get(i.id) ?? 'OPEN' }));
  }

  private async effectiveStatus(em: EntityManager, id: number): Promise<string> {
    const [row] = await em.query(
      `SELECT ${effectiveStatusSql()} AS eff FROM schedule_item si JOIN production_order po ON po.id = si.production_order_id WHERE si.id = $1`,
      [id],
    );
    return row?.eff ?? 'OPEN';
  }

  // ---------------------------------------------------------------------------
  // Controlli
  // ---------------------------------------------------------------------------

  /** Pezzi da produrre del particolare: quantità ordine × quantità del particolare nel disegno (errore se non ne fa parte). */
  private async quantityFor(em: EntityManager, order: ProductionOrder, partId: number): Promise<number> {
    const [row] = await em.query('SELECT SUM(quantity)::int AS q FROM drawing_part WHERE drawing_id = $1 AND part_id = $2', [order.drawingId, partId]);
    if (row?.q == null) {
      const [p] = await em.query('SELECT internal_code FROM part WHERE id = $1', [partId]);
      throw new BadRequestException(
        `Il particolare ${p?.internal_code ?? `#${partId}`} non fa parte del disegno ${order.drawing?.code ?? ''} dell'ordine n. ${order.id}.`.replace('  ', ' '),
      );
    }
    return order.quantity * row.q;
  }

  private async requireSchedulableMachine(em: EntityManager, machineId: number): Promise<Machine> {
    const m = await em.findOne(Machine, { where: { id: machineId } });
    if (!m) throw new BadRequestException(`Macchina #${machineId} non trovata`);
    if (!m.schedulable) throw new BadRequestException(`La macchina ${m.name} non è abilitata alla pianificazione`);
    return m;
  }

  private async maxOpenPosition(em: EntityManager, machineId: number): Promise<number> {
    const [row] = await em.query(
      `SELECT COUNT(*)::int AS n FROM schedule_item si JOIN production_order po ON po.id = si.production_order_id
        WHERE si.machine_id = $1 AND si.deleted_at IS NULL AND po.deleted_at IS NULL AND ${effectiveStatusSql()} <> 'DONE'`,
      [machineId],
    );
    return row.n;
  }

  // ---------------------------------------------------------------------------
  // Creazione, modifica, spostamento, eliminazione
  // ---------------------------------------------------------------------------

  private async insert(em: EntityManager, order: ProductionOrder, partId: number, machineId: number, quantity: number, t: ScheduleTimesDto, position?: number | null) {
    await renumberMachine(em, machineId);
    const pos = provisionalPosition({ requested: position, maxPosition: await this.maxOpenPosition(em, machineId) });
    const saved = await em.save(
      em.create(ScheduleItem, {
        productionOrderId: order.id, partId, machineId, quantity, position: pos, status: 'OPEN',
        setupSeconds: t.setupSeconds, unitSeconds: t.unitSeconds,
        internalPauseSeconds: t.internalPauseSeconds ?? 0, endPauseSeconds: t.endPauseSeconds ?? 0,
      }),
    );
    return saved;
  }

  async createItem(dto: CreateScheduleItemDto): Promise<ScheduleItemWithStatus> {
    const id = await this.dataSource.transaction(async (em) => {
      await lockQueue(em, 'machine', dto.machineId);
      const order = await this.orders.requireOpenOrder(em, dto.productionOrderId);
      await this.requireSchedulableMachine(em, dto.machineId);
      const qty = await this.quantityFor(em, order, dto.partId);
      const saved = await this.insert(em, order, dto.partId, dto.machineId, qty, dto, dto.position);
      await renumberMachine(em, dto.machineId);
      await writeAudit(em, 'schedule_item', 'CREATE', saved.id, dto);
      return saved.id;
    });
    return this.get(id);
  }

  /** Inserimento multiplo: una lavorazione per riga, ognuna in fondo alla coda della macchina. */
  async createBulk(dto: BulkCreateScheduleItemsDto): Promise<ScheduleItemWithStatus[]> {
    const ids = await this.dataSource.transaction(async (em) => {
      await lockQueue(em, 'machine', dto.machineId);
      const order = await this.orders.requireOpenOrder(em, dto.productionOrderId);
      await this.requireSchedulableMachine(em, dto.machineId);
      const qty = await this.quantityFor(em, order, dto.partId);
      const out: number[] = [];
      for (const row of dto.rows) {
        const saved = await this.insert(em, order, dto.partId, dto.machineId, qty, row, null);
        out.push(saved.id);
      }
      await renumberMachine(em, dto.machineId);
      await writeAudit(em, 'schedule_item', 'CREATE', out.join(','), dto, `Inserite ${out.length} lavorazioni per l'ordine n. ${order.id}`);
      return out;
    });
    return this.withStatus(this.repo.manager, await this.repo.find({ where: { id: In(ids) }, relations: { machine: true, part: true }, order: { position: 'ASC' } }));
  }

  /** Sposta in un'altra posizione e/o macchina (regole 02-produzione §4.4), dentro una transazione aperta. */
  private async moveInTx(em: EntityManager, item: ScheduleItem, machineId: number, position?: number | null): Promise<void> {
    const machines = [...new Set([item.machineId, machineId])].sort((a, b) => a - b);
    for (const m of machines) await lockQueue(em, 'machine', m);
    if ((await this.effectiveStatus(em, item.id)) === 'DONE') {
      throw new BadRequestException('La lavorazione è conclusa: non si può spostare.');
    }
    if (machineId !== item.machineId) await this.requireSchedulableMachine(em, machineId);
    for (const m of machines) await renumberMachine(em, m);
    const fresh = await em.findOneOrFail(ScheduleItem, { where: { id: item.id } });
    const same = machineId === fresh.machineId;
    const max = await this.maxOpenPosition(em, machineId);
    const pos = provisionalPosition({ requested: position, currentRank: same ? fresh.position : null, maxPosition: max });
    if (same && position == null) return;
    await em.update(ScheduleItem, item.id, { machineId, position: pos });
    for (const m of machines) await renumberMachine(em, m);
  }

  async move(id: number, machineId: number, position?: number | null): Promise<ScheduleItemWithStatus> {
    await this.dataSource.transaction(async (em) => {
      const item = await em.findOne(ScheduleItem, { where: { id } });
      if (!item) throw new NotFoundException(`${LABEL} non trovata (id ${id})`);
      await this.moveInTx(em, item, machineId, position);
      await writeAudit(em, 'schedule_item', 'ACTION', id, { fromMachineId: item.machineId, machineId, position }, 'Spostamento in coda');
    });
    return this.get(id);
  }

  async updateItem(id: number, dto: UpdateScheduleItemDto): Promise<ScheduleItemWithStatus> {
    await this.dataSource.transaction(async (em) => {
      const item = await em.findOne(ScheduleItem, { where: { id } });
      if (!item) throw new NotFoundException(`${LABEL} non trovata (id ${id})`);
      const patch: Partial<ScheduleItem> = {};
      for (const k of ['setupSeconds', 'unitSeconds', 'internalPauseSeconds', 'endPauseSeconds'] as const) {
        if (dto[k] !== undefined) patch[k] = dto[k]!;
      }
      if (dto.partId !== undefined && dto.partId !== item.partId) {
        const order = await em.findOne(ProductionOrder, { where: { id: item.productionOrderId }, relations: { drawing: true }, withDeleted: true });
        patch.partId = dto.partId;
        patch.quantity = await this.quantityFor(em, order!, dto.partId);
      }
      if (Object.keys(patch).length) await em.update(ScheduleItem, id, patch);
      const targetMachine = dto.machineId ?? item.machineId;
      if (targetMachine !== item.machineId || dto.position != null) await this.moveInTx(em, item, targetMachine, dto.position);
      await writeAudit(em, 'schedule_item', 'UPDATE', id, dto);
    });
    return this.get(id);
  }

  async removeItem(id: number): Promise<void> {
    await this.dataSource.transaction(async (em) => {
      const item = await em.findOne(ScheduleItem, { where: { id } });
      if (!item) throw new NotFoundException(`${LABEL} non trovata (id ${id})`);
      const [ph] = await em.query('SELECT COUNT(*)::int AS n FROM work_phase WHERE schedule_item_id = $1 AND deleted_at IS NULL', [id]);
      if (ph.n > 0) {
        throw new ConflictException(`La lavorazione ha ${ph.n} fasi registrate in reparto e resta nello storico: non si può eliminare.`);
      }
      await lockQueue(em, 'machine', item.machineId);
      await em.softDelete(ScheduleItem, id);
      await renumberMachine(em, item.machineId);
      await writeAudit(em, 'schedule_item', 'DELETE', id);
    });
  }

  // ---------------------------------------------------------------------------
  // Proposta dei tempi per l'inserimento
  // ---------------------------------------------------------------------------

  /**
   * Tempi proposti per ordine + particolare + macchina: fasi del preventivo collegato all'ordine cliente
   * (stessa macchina o, se la fase non ha macchina, stessa tipologia); in mancanza le fasi del ciclo del
   * particolare per la tipologia della macchina.
   */
  async proposal(productionOrderId: number, partId: number, machineId: number) {
    const em = this.repo.manager;
    const order = await em.findOne(ProductionOrder, { where: { id: productionOrderId }, relations: { drawing: true } });
    if (!order) throw new NotFoundException(`Ordine di produzione n. ${productionOrderId} non trovato`);
    const machine = await em.findOne(Machine, { where: { id: machineId } });
    if (!machine) throw new NotFoundException(`Macchina #${machineId} non trovata`);
    const quantity = await this.quantityFor(em, order, partId);

    const quoteRows: { quote_id: number; quote_number: string; machine_id: number | null; setup_seconds: number; unit_seconds: number; sequence: number }[] = await em.query(
      `SELECT q.id AS quote_id, q.number AS quote_number, qpp.machine_id, qpp.setup_seconds, qpp.unit_seconds, qpp.sequence
         FROM quote q
         JOIN quote_part qp ON qp.quote_id = q.id AND qp.deleted_at IS NULL
         JOIN quote_part_phase qpp ON qpp.quote_part_id = qp.id
        WHERE q.customer_order_id = $1 AND q.deleted_at IS NULL AND qp.part_id = $2
          AND (qpp.machine_id = $3 OR (qpp.machine_id IS NULL AND qpp.machine_type_id = $4))
        ORDER BY q.issue_date DESC, q.id DESC, qp.sort_order, qpp.sequence, qpp.id`,
      [order.customerOrderId, partId, machineId, machine.machineTypeId],
    );
    if (quoteRows.length) {
      const latest = quoteRows.filter((r) => r.quote_id === quoteRows[0].quote_id);
      const exact = latest.filter((r) => r.machine_id === machineId);
      const rows = exact.length ? exact : latest;
      return {
        source: 'QUOTE' as const,
        sourceLabel: `Preventivo ${rows[0].quote_number}`,
        quantity,
        rows: rows.map((r) => ({ setupSeconds: r.setup_seconds, unitSeconds: r.unit_seconds, internalPauseSeconds: 0, endPauseSeconds: 0 })),
      };
    }
    const cycle = await em.find(PartCycleStep, { where: { partId, machineTypeId: machine.machineTypeId }, order: { sequence: 'ASC', id: 'ASC' } });
    if (cycle.length) {
      return {
        source: 'CYCLE' as const,
        sourceLabel: 'Ciclo di lavorazione del particolare',
        quantity,
        rows: cycle.map((c) => ({ setupSeconds: c.setupSeconds, unitSeconds: c.unitSeconds, internalPauseSeconds: 0, endPauseSeconds: 0 })),
      };
    }
    return { source: 'NONE' as const, sourceLabel: 'Nessun tempo trovato: inserirli a mano', quantity, rows: [] };
  }
}
