import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, IsNull, Not, Repository, SelectQueryBuilder } from 'typeorm';
import { PRODUCTION_ORDER_STATUS_LABELS, type ProductionOrderStatus } from '../../../shared';
import { CrudService, writeAudit } from '../../../common/crud/crud.service';
import { ListQueryDto } from '../../../common/crud/list-query.dto';
import {
  CustomerOrder, CustomerOrderLine, CutQueueItem, Drawing, DrawingPart, Inspection, PartCycleStep, ProductionOrder,
  ProductionOrderPart, ScheduleItem, Treatment, WorkPhase,
} from '../../../entities';
import {
  EFFECTIVE_STATUS_SQL, describeActivity, hasActivity, lockQueue, orderActivity, renumberCutQueue, renumberMachine, todayIn,
} from '../common/production-db';
import { CreateProductionOrderDto, UpdateProductionOrderDto } from './production-orders.dto';

const LABEL = 'Ordine di produzione';

@Injectable()
export class ProductionOrdersService extends CrudService<ProductionOrder> {
  private readonly timeZone: string;

  constructor(
    @InjectRepository(ProductionOrder) repo: Repository<ProductionOrder>,
    @InjectDataSource() private readonly dataSource: DataSource,
    config: ConfigService,
  ) {
    super(repo, {
      label: LABEL,
      relations: ['drawing', 'customerOrder', 'customerOrder.customer'],
      searchFields: ['id', 'drawing.code', 'drawing.name', 'customerOrder.code', 'customerOrder.customer.name', 'notes'],
      sortable: ['id', 'expectedDeliveryDate', 'status', 'quantity', 'completedAt', 'createdAt', 'drawing.code', 'customerOrder.code', 'customerOrder.customer.name'],
      filterable: ['customerOrderId', 'drawingId', 'customerOrderLineId'],
      defaultSort: { field: 'expectedDeliveryDate', order: 'asc' },
    });
    this.timeZone = config.get<string>('timezone') ?? 'Europe/Rome';
  }

  /**
   * Filtri speciali: `status` (OPEN = non completati, oppure elenco di stati), `customerId`,
   * `late` (consegna passata e non completati).
   */
  protected override customizeList(qb: SelectQueryBuilder<ProductionOrder>, query: ListQueryDto): void {
    const f = query.filter ?? {};
    if (f.status === 'OPEN') qb.andWhere("e.status <> 'COMPLETED'");
    else if (f.status) qb.andWhere('e.status IN (:...st)', { st: f.status.split(',') });
    if (f.customerId) qb.andWhere('customerOrder.customerId = :cid', { cid: Number(f.customerId) });
    if (f.late === 'true') {
      qb.andWhere("e.status <> 'COMPLETED' AND e.expectedDeliveryDate < :today", { today: todayIn(this.timeZone) });
    }
  }

  // ---------------------------------------------------------------------------
  // Lettura
  // ---------------------------------------------------------------------------

  /** Scheda completa dell'ordine: particolari e taglio, pianificazione, fasi, collaudi, avanzamento. */
  async detail(id: number) {
    const order = await this.repo.findOne({
      where: { id },
      withDeleted: true,
      relations: { drawing: true, customerOrder: { customer: true }, customerOrderLine: true, treatments: true },
    });
    if (!order) throw new NotFoundException(`${LABEL} non trovato (id ${id})`);
    const em = this.repo.manager;

    const parts = await em.find(ProductionOrderPart, {
      where: { productionOrderId: id },
      relations: { part: { material: true, barType: true } },
      order: { id: 'ASC' },
    });
    const partIds = [...new Set(parts.map((p) => p.partId))];
    const cycle = partIds.length
      ? await em.find(PartCycleStep, { where: { partId: In(partIds) }, relations: { machineType: true }, order: { sequence: 'ASC', id: 'ASC' } })
      : [];
    const cutRows = await em.find(CutQueueItem, { where: { productionOrderId: id }, order: { id: 'DESC' } });
    const goods: { part_id: number; machine_type_id: number; good: number; scrap: number }[] = await em.query(
      `SELECT wp.part_id, m.machine_type_id, SUM(COALESCE(wp.good_qty, 0))::int AS good, SUM(COALESCE(wp.scrap_qty, 0))::int AS scrap
         FROM work_phase wp JOIN machine m ON m.id = wp.machine_id
        WHERE wp.production_order_id = $1 AND wp.deleted_at IS NULL AND wp.part_id IS NOT NULL
        GROUP BY wp.part_id, m.machine_type_id`,
      [id],
    );

    const partRows = parts.map((p) => {
      const steps = cycle.filter((s) => s.partId === p.partId);
      const hasCutting = steps.some((s) => s.machineType?.isCutting && !s.machineType.deletedAt);
      const prodSteps = steps.filter((s) => !s.machineType?.isCutting && !s.machineType?.isInspection);
      const partGoods = goods.filter((g) => g.part_id === p.partId);
      const progress = prodSteps.map((s) => {
        const g = partGoods.find((x) => x.machine_type_id === s.machineTypeId);
        return { machineTypeId: s.machineTypeId, machineTypeName: s.machineType?.name ?? '', goodQty: g?.good ?? 0, scrapQty: g?.scrap ?? 0 };
      });
      // Pezzi buoni del particolare = pezzi che hanno passato tutte le fasi del ciclo (minimo tra le tipologie);
      // senza ciclo: il massimo registrato su una qualunque macchina.
      const goodQty = progress.length ? Math.min(...progress.map((x) => x.goodQty)) : Math.max(0, ...partGoods.map((g) => g.good));
      const scrapQty = partGoods.reduce((s, g) => s + g.scrap, 0);
      const cut = cutRows.find((c) => c.productionOrderPartId === p.id && !c.deletedAt) ?? null;
      return {
        id: p.id,
        partId: p.partId,
        part: p.part,
        quantityPerUnit: p.quantityPerUnit,
        requiredQty: order.quantity * p.quantityPerUnit,
        cutStatus: p.cutStatus,
        hasCutting,
        cutQueueItem: cut && { id: cut.id, status: cut.status, position: cut.position, startedAt: cut.startedAt, completedAt: cut.completedAt },
        goodQty,
        scrapQty,
        progress,
      };
    });

    const scheduleItems = await this.scheduleItemsOf(em, id);
    const phases = await em.find(WorkPhase, {
      where: { productionOrderId: id },
      relations: { operator: true, machine: true, part: true, stops: { stopReason: true } },
      order: { setupStartedAt: 'DESC' },
    });
    const inspections = await em.find(Inspection, {
      where: { productionOrderId: id },
      relations: { operator: true, machine: true },
      order: { startedAt: 'DESC' },
    });

    const required = partRows.reduce((s, p) => s + p.requiredQty, 0);
    const good = partRows.reduce((s, p) => s + Math.min(p.goodQty, p.requiredQty), 0);
    const today = todayIn(this.timeZone);
    return {
      ...order,
      late: order.status !== 'COMPLETED' && !!order.expectedDeliveryDate && order.expectedDeliveryDate < today,
      parts: partRows,
      scheduleItems,
      phases: phases.map((ph) => ({ ...ph, stops: (ph.stops ?? []).filter((s) => !s.deletedAt) })),
      inspections,
      progress: {
        requiredPieces: required,
        goodPieces: good,
        ratio: required > 0 ? good / required : 0,
        inspectedGood: inspections.reduce((s, i) => s + (i.goodQty ?? 0), 0),
        inspectedScrap: inspections.reduce((s, i) => s + (i.scrapQty ?? 0), 0),
        lastInspectionEnd: inspections.map((i) => i.endedAt).filter(Boolean).sort().pop() ?? null,
      },
    };
  }

  private async scheduleItemsOf(em: EntityManager, orderId: number) {
    const rows: { id: number; eff: string }[] = await em.query(
      `SELECT si.id, ${EFFECTIVE_STATUS_SQL} AS eff FROM schedule_item si JOIN production_order po ON po.id = si.production_order_id
        WHERE si.production_order_id = $1 AND si.deleted_at IS NULL`,
      [orderId],
    );
    if (!rows.length) return [];
    const items = await em.find(ScheduleItem, {
      where: { id: In(rows.map((r) => r.id)) },
      relations: { machine: true, part: true },
      order: { machineId: 'ASC', position: 'ASC' },
    });
    const eff = new Map(rows.map((r) => [r.id, r.eff]));
    return items.map((i) => ({ ...i, effectiveStatus: eff.get(i.id) }));
  }

  // ---------------------------------------------------------------------------
  // Creazione e modifica
  // ---------------------------------------------------------------------------

  private async validateRefs(em: EntityManager, dto: Partial<CreateProductionOrderDto>, current?: ProductionOrder): Promise<void> {
    const customerOrderId = dto.customerOrderId ?? current?.customerOrderId;
    if (dto.customerOrderId !== undefined) {
      const co = await em.findOne(CustomerOrder, { where: { id: dto.customerOrderId } });
      if (!co) throw new BadRequestException("L'ordine cliente scelto non esiste o è stato eliminato");
    }
    if (dto.drawingId !== undefined) {
      const d = await em.findOne(Drawing, { where: { id: dto.drawingId } });
      if (!d) throw new BadRequestException('Il disegno scelto non esiste o è stato eliminato');
    }
    if (dto.customerOrderLineId) {
      const line = await em.findOne(CustomerOrderLine, { where: { id: dto.customerOrderLineId } });
      if (!line || line.customerOrderId !== customerOrderId) {
        throw new BadRequestException("La riga indicata non appartiene all'ordine cliente scelto");
      }
    }
    if (dto.stockQuantity != null && dto.quantity != null && dto.stockQuantity > dto.quantity) {
      throw new BadRequestException('La quantità per magazzino non può superare la quantità da produrre');
    }
  }

  private async drawingTreatments(em: EntityManager, drawingId: number): Promise<number[]> {
    const rows: { treatment_id: number }[] = await em.query('SELECT treatment_id FROM drawing_treatment WHERE drawing_id = $1', [drawingId]);
    return rows.map((r) => r.treatment_id);
  }

  private async setTreatments(em: EntityManager, orderId: number, ids: number[]): Promise<void> {
    const unique = [...new Set(ids)];
    if (unique.length) {
      const found = await em.count(Treatment, { where: { id: In(unique) } });
      if (found !== unique.length) throw new BadRequestException('Uno dei trattamenti scelti non esiste');
    }
    await em.query('DELETE FROM production_order_treatment WHERE production_order_id = $1', [orderId]);
    for (const t of unique) {
      await em.query('INSERT INTO production_order_treatment (production_order_id, treatment_id) VALUES ($1, $2)', [orderId, t]);
    }
  }

  /** Un particolare dell'ordine per ogni riga della composizione del disegno. */
  private async generateParts(em: EntityManager, orderId: number, drawingId: number): Promise<number> {
    const rows = await em.find(DrawingPart, { where: { drawingId }, order: { position: 'ASC', id: 'ASC' } });
    for (const r of rows) {
      await em.save(em.create(ProductionOrderPart, { productionOrderId: orderId, partId: r.partId, quantityPerUnit: r.quantity, cutStatus: 'NONE' }));
    }
    return rows.length;
  }

  /**
   * Crea un ordine di produzione: stato "Da iniziare", particolari dalla composizione del disegno,
   * trattamenti indicati o, se assenti, quelli del disegno. Utilizzabile anche dentro una transazione esterna
   * (es. conferma dell'ordine cliente) passando `em`.
   */
  async createOrder(dto: CreateProductionOrderDto, em?: EntityManager): Promise<ProductionOrder> {
    const run = async (m: EntityManager) => {
      await this.validateRefs(m, dto);
      const order = await m.save(
        m.create(ProductionOrder, {
          customerOrderId: dto.customerOrderId,
          customerOrderLineId: dto.customerOrderLineId ?? null,
          drawingId: dto.drawingId,
          quantity: dto.quantity,
          stockQuantity: dto.stockQuantity ?? 0,
          expectedDeliveryDate: dto.expectedDeliveryDate ? dto.expectedDeliveryDate.slice(0, 10) : null,
          notes: dto.notes ?? null,
          status: 'TO_DO',
        }),
      );
      await this.setTreatments(m, order.id, dto.treatmentIds ?? (await this.drawingTreatments(m, dto.drawingId)));
      const n = await this.generateParts(m, order.id, dto.drawingId);
      await writeAudit(m, 'production_order', 'CREATE', order.id, dto, `Creato ordine di produzione n. ${order.id} con ${n} particolari`);
      return order;
    };
    return em ? run(em) : this.dataSource.transaction(run);
  }

  async createAndLoad(dto: CreateProductionOrderDto) {
    const order = await this.createOrder(dto);
    return this.detail(order.id);
  }

  /**
   * Modifica: non tocca la coda di taglio; il cambio disegno è ammesso solo senza attività registrate
   * e rigenera i particolari; il cambio quantità aggiorna i pezzi delle lavorazioni non concluse.
   */
  async updateOrder(id: number, dto: UpdateProductionOrderDto) {
    await this.dataSource.transaction(async (em) => {
      const order = await em.findOne(ProductionOrder, { where: { id } });
      if (!order) throw new NotFoundException(`${LABEL} non trovato (id ${id})`);
      await this.validateRefs(em, { ...dto, quantity: dto.quantity ?? order.quantity, stockQuantity: dto.stockQuantity ?? order.stockQuantity }, order);

      const drawingChanged = dto.drawingId !== undefined && dto.drawingId !== order.drawingId;
      if (drawingChanged) {
        const act = await orderActivity(em, id);
        if (hasActivity(act)) {
          throw new ConflictException(`Non si può cambiare il disegno: sull'ordine sono già registrate attività di reparto (${describeActivity(act)}).`);
        }
      }

      const patch: Partial<ProductionOrder> = {};
      if (dto.customerOrderId !== undefined) patch.customerOrderId = dto.customerOrderId;
      if (dto.customerOrderLineId !== undefined) patch.customerOrderLineId = dto.customerOrderLineId ?? null;
      if (dto.drawingId !== undefined) patch.drawingId = dto.drawingId;
      if (dto.quantity !== undefined) patch.quantity = dto.quantity;
      if (dto.stockQuantity !== undefined) patch.stockQuantity = dto.stockQuantity;
      if (dto.expectedDeliveryDate !== undefined) patch.expectedDeliveryDate = dto.expectedDeliveryDate ? dto.expectedDeliveryDate.slice(0, 10) : null;
      if (dto.notes !== undefined) patch.notes = dto.notes ?? null;
      if (Object.keys(patch).length) await em.update(ProductionOrder, id, patch);
      if (dto.treatmentIds !== undefined) await this.setTreatments(em, id, dto.treatmentIds);

      if (drawingChanged) {
        // Nessuna attività: tagli in attesa e lavorazioni dei particolari non più nel disegno si eliminano.
        await lockQueue(em, 'cut');
        await em.softDelete(CutQueueItem, { productionOrderId: id, status: 'WAITING' });
        await em.delete(ProductionOrderPart, { productionOrderId: id });
        const n = await this.generateParts(em, id, dto.drawingId!);
        const newPartIds = (await em.find(DrawingPart, { where: { drawingId: dto.drawingId! } })).map((r) => r.partId);
        const stale = await em.find(ScheduleItem, {
          where: { productionOrderId: id, ...(newPartIds.length ? { partId: Not(In(newPartIds)) } : {}) },
        });
        for (const machineId of [...new Set(stale.map((s) => s.machineId))]) await lockQueue(em, 'machine', machineId);
        if (stale.length) await em.softDelete(ScheduleItem, stale.map((s) => s.id));
        for (const machineId of [...new Set(stale.map((s) => s.machineId))]) await renumberMachine(em, machineId);
        await renumberCutQueue(em);
        await writeAudit(em, 'production_order', 'ACTION', id, { drawingId: dto.drawingId, removedScheduleItems: stale.map((s) => s.id) },
          `Cambio disegno: rigenerati ${n} particolari, eliminate ${stale.length} lavorazioni non più valide`);
      }

      if (dto.quantity !== undefined && dto.quantity !== order.quantity) {
        await em.query(
          `UPDATE schedule_item si SET quantity = $2 * COALESCE(
               (SELECT SUM(quantity_per_unit) FROM production_order_part pop WHERE pop.production_order_id = si.production_order_id AND pop.part_id = si.part_id), 1)
            WHERE si.production_order_id = $1 AND si.deleted_at IS NULL AND si.status <> 'DONE'`,
          [id, dto.quantity],
        );
      }
      await writeAudit(em, 'production_order', 'UPDATE', id, dto);
    });
    return this.detail(id);
  }

  /**
   * Cambio stato manuale.
   * - Completato: data completamento, lavorazioni aperte concluse, righe di taglio non iniziate eliminate.
   * - Riapertura: le lavorazioni chiuse dal completamento (senza fasi concluse) tornano in coda in fondo,
   *   i particolari rimasti senza riga di taglio tornano da approvare.
   */
  async changeStatus(id: number, status: ProductionOrderStatus) {
    await this.dataSource.transaction(async (em) => {
      const order = await em.findOne(ProductionOrder, { where: { id } });
      if (!order) throw new NotFoundException(`${LABEL} non trovato (id ${id})`);
      if (order.status === status) return;
      const now = new Date();
      const summary: string[] = [`Stato: ${PRODUCTION_ORDER_STATUS_LABELS[order.status]} → ${PRODUCTION_ORDER_STATUS_LABELS[status]}`];

      if (status === 'COMPLETED') {
        const open = await em.find(ScheduleItem, { where: { productionOrderId: id, status: Not('DONE') } });
        const machines = [...new Set(open.map((s) => s.machineId))];
        for (const m of machines) await lockQueue(em, 'machine', m);
        if (open.length) await em.update(ScheduleItem, { id: In(open.map((s) => s.id)) }, { status: 'DONE', completedAt: now });
        await lockQueue(em, 'cut');
        const waiting = await em.find(CutQueueItem, { where: { productionOrderId: id, status: 'WAITING' } });
        if (waiting.length) await em.softDelete(CutQueueItem, waiting.map((c) => c.id));
        await em.update(ProductionOrder, id, { status, completedAt: now, startedAt: order.startedAt ?? now });
        for (const m of machines) await renumberMachine(em, m);
        await renumberCutQueue(em);
        summary.push(`${open.length} lavorazioni concluse, ${waiting.length} righe di taglio non iniziate eliminate`);
      } else {
        if (order.status === 'COMPLETED') {
          const reopened: { id: number; machine_id: number; has_phase: boolean }[] = await em.query(
            `SELECT si.id, si.machine_id,
                    EXISTS (SELECT 1 FROM work_phase wp WHERE wp.schedule_item_id = si.id AND wp.deleted_at IS NULL) AS has_phase
               FROM schedule_item si
              WHERE si.production_order_id = $1 AND si.deleted_at IS NULL AND si.status = 'DONE'
                AND NOT EXISTS (SELECT 1 FROM work_phase wp WHERE wp.schedule_item_id = si.id AND wp.deleted_at IS NULL AND wp.status = 'COMPLETED')`,
            [id],
          );
          await em.update(ProductionOrder, id, { status, completedAt: null });
          const machines = [...new Set(reopened.map((r) => r.machine_id))];
          for (const m of machines) await lockQueue(em, 'machine', m);
          for (const r of reopened) {
            await em.query(
              `UPDATE schedule_item SET status = $2, completed_at = NULL,
                      position = 1000000 + (SELECT COALESCE(MAX(position), 0) FROM schedule_item WHERE machine_id = $3 AND deleted_at IS NULL)
                WHERE id = $1`,
              [r.id, r.has_phase ? 'IN_PROGRESS' : 'OPEN', r.machine_id],
            );
          }
          for (const m of machines) await renumberMachine(em, m);
          await em.query(
            `UPDATE production_order_part pop SET cut_status = 'NONE', updated_at = now()
              WHERE pop.production_order_id = $1 AND pop.cut_status = 'APPROVED'
                AND NOT EXISTS (SELECT 1 FROM cut_queue_item c WHERE c.production_order_part_id = pop.id AND c.deleted_at IS NULL)`,
            [id],
          );
          summary.push(`riaperto: ${reopened.length} lavorazioni rimesse in coda`);
        } else {
          await em.update(ProductionOrder, id, { status });
        }
        if (status === 'IN_PROGRESS' && !order.startedAt) await em.update(ProductionOrder, id, { startedAt: now });
      }
      await writeAudit(em, 'production_order', 'ACTION', id, { from: order.status, to: status }, summary.join('; '));
    });
    return this.detail(id);
  }

  /** Eliminazione: vietata con attività registrate; elimina anche lavorazioni pianificate e tagli non iniziati. */
  async removeOrder(id: number): Promise<void> {
    await this.dataSource.transaction(async (em) => {
      const order = await em.findOne(ProductionOrder, { where: { id } });
      if (!order) throw new NotFoundException(`${LABEL} non trovato (id ${id})`);
      const act = await orderActivity(em, id);
      if (hasActivity(act)) {
        throw new ConflictException(
          `Non si può eliminare l'ordine n. ${id}: sono registrate attività di reparto (${describeActivity(act)}). Se il lavoro è finito, impostare lo stato "Completato".`,
        );
      }
      const items = await em.find(ScheduleItem, { where: { productionOrderId: id } });
      const machines = [...new Set(items.map((s) => s.machineId))];
      for (const m of machines) await lockQueue(em, 'machine', m);
      await lockQueue(em, 'cut');
      if (items.length) await em.softDelete(ScheduleItem, items.map((s) => s.id));
      const cuts = await em.find(CutQueueItem, { where: { productionOrderId: id, status: 'WAITING' } });
      if (cuts.length) await em.softDelete(CutQueueItem, cuts.map((c) => c.id));
      await em.softDelete(ProductionOrder, id);
      for (const m of machines) await renumberMachine(em, m);
      await renumberCutQueue(em);
      await writeAudit(em, 'production_order', 'DELETE', id, { scheduleItems: items.length, cutQueueItems: cuts.length },
        `Eliminato ordine di produzione n. ${id} con ${items.length} lavorazioni pianificate e ${cuts.length} righe di taglio`);
    });
  }

  /** Ordini non completati con consegna passata. */
  async countLate(): Promise<number> {
    return this.repo
      .createQueryBuilder('o')
      .where("o.status <> 'COMPLETED'")
      .andWhere('o.expectedDeliveryDate < :today', { today: todayIn(this.timeZone) })
      .getCount();
  }

  /** Usato dalla pianificazione: ordine valido (non eliminato) o errore chiaro. */
  async requireOpenOrder(em: EntityManager, id: number): Promise<ProductionOrder> {
    const order = await em.findOne(ProductionOrder, { where: { id, deletedAt: IsNull() }, relations: { drawing: true } });
    if (!order) throw new BadRequestException(`Ordine di produzione n. ${id} non trovato`);
    if (order.status === 'COMPLETED') throw new BadRequestException(`L'ordine di produzione n. ${id} è completato: riaprirlo prima di pianificare.`);
    return order;
  }
}
