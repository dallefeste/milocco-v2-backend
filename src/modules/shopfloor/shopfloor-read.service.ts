import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { BAR_SHAPES } from '../../shared';
import { DataSource } from 'typeorm';
import { SettingsService } from '../settings/settings.service';
import { ShopfloorActionsService } from './shopfloor-actions.service';
import {
  barCutPlan, compareIt, groupOrdersByMaterial, metersToMm, pieceLengthMm, shapeFamily, splitDimensions, subgroupOf,
} from './shopfloor.rules';
import type {
  ActivePhaseView, BarTypeView, CustomerView, CutQueueView, InspectionSummaryView, InspectionView, NamedItem,
  NextPlannedView, OperatorView, OrderGroupView, OrderHeader, OrderListItem, OrderPartView, OrderSummaryView, PartHeader,
  PhaseGroups, PhaseView, ShopState, StationView, StopReasonView, StopView, SubgroupView,
} from './shopfloor.types';

type Row = Record<string, any>;

const iso = (v: unknown): string | null => (v ? new Date(v as string).toISOString() : null);
const num = (v: unknown): number => Number(v ?? 0);
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/** Ordini visibili sul tablet: non eliminati e non completati, con ordine cliente e cliente non eliminati (A17). */
const OPEN_ORDERS_FROM = `
  FROM production_order po
  JOIN customer_order co ON co.id = po.customer_order_id AND co.deleted_at IS NULL
  JOIN customer c ON c.id = co.customer_id AND c.deleted_at IS NULL
  JOIN drawing d ON d.id = po.drawing_id
  WHERE po.deleted_at IS NULL AND po.status <> 'COMPLETED'`;

const ORDER_HEADER_SELECT = `
  po.id AS po_id, po.status AS po_status, po.quantity AS po_quantity, po.expected_delivery_date AS po_delivery,
  po.drawing_id AS po_drawing_id, d.code AS d_code, d.revision AS d_revision, co.code AS co_code,
  c.id AS c_id, c.name AS c_name`;

/** Pezzi del particolare per una unità di disegno: dai particolari dell'ordine, altrimenti dalla composizione del disegno. */
const QTY_PER_UNIT = (orderAlias: string, partExpr: string) => `COALESCE(
  (SELECT SUM(pop.quantity_per_unit) FROM production_order_part pop WHERE pop.production_order_id = ${orderAlias}.id AND pop.part_id = ${partExpr}),
  (SELECT SUM(dp.quantity) FROM drawing_part dp WHERE dp.drawing_id = ${orderAlias}.drawing_id AND dp.part_id = ${partExpr}),
  1)`;

const PART_SELECT = `
  pt.id AS pt_id, pt.internal_code AS pt_code, pt.name AS pt_name, pt.bar_cut AS pt_bar_cut, pt.bar_type_id AS pt_bar_type_id,
  bt.code AS bt_code, mat.name AS mat_name`;

const PART_JOINS = `
  LEFT JOIN material mat ON mat.id = pt.material_id
  LEFT JOIN bar_type bt ON bt.id = pt.bar_type_id`;

const PHASE_SELECT = `
  SELECT wp.id, wp.production_order_id, wp.phase_number, wp.status, wp.operator_id,
    trim(op.first_name || ' ' || op.last_name) AS operator_name, wp.machine_id, m.name AS machine_name,
    wp.part_id, pp.internal_code AS part_code, wp.good_qty, wp.scrap_qty, wp.setup_started_at, wp.setup_ended_at,
    wp.work_started_at, wp.work_ended_at, wp.avg_unit_seconds, wp.resumed_from_id, wp.schedule_item_id,
    EXISTS (
      SELECT 1 FROM work_phase r
      WHERE r.deleted_at IS NULL AND r.id <> wp.id AND (
        r.resumed_from_id = wp.id OR (
          r.resumed_from_id IS NULL AND r.production_order_id = wp.production_order_id
          AND r.part_id IS NOT DISTINCT FROM wp.part_id AND r.phase_number = wp.phase_number AND r.id > wp.id))
    ) AS resumed
  FROM work_phase wp
  JOIN operator op ON op.id = wp.operator_id
  JOIN machine m ON m.id = wp.machine_id
  LEFT JOIN part pp ON pp.id = wp.part_id`;

/** Letture per l'app tablet. */
@Injectable()
export class ShopfloorReadService {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly settings: SettingsService,
    private readonly actions: ShopfloorActionsService,
  ) {}

  // ---------------------------------------------------------------------------------------------
  // Mappature
  // ---------------------------------------------------------------------------------------------

  private orderHeader(r: Row): OrderHeader {
    return {
      productionOrderId: r.po_id,
      status: r.po_status,
      customerId: r.c_id,
      customerName: r.c_name,
      customerOrderCode: r.co_code ?? '',
      drawingId: r.po_drawing_id,
      drawingCode: r.d_code ?? '',
      drawingRevision: r.d_revision ?? '',
      orderQuantity: num(r.po_quantity),
      expectedDeliveryDate: r.po_delivery ? String(r.po_delivery instanceof Date ? r.po_delivery.toISOString().slice(0, 10) : r.po_delivery) : null,
    };
  }

  private partHeader(r: Row): PartHeader {
    const perUnit = num(r.qty_per_unit) || 1;
    return {
      partId: r.pt_id,
      internalCode: r.pt_code ?? '',
      name: r.pt_name ?? '',
      materialName: r.mat_name ?? null,
      quantityPerUnit: perUnit,
      totalQuantity: num(r.po_quantity) * perUnit,
      barCut: !!r.pt_bar_cut,
      barTypeId: r.pt_bar_type_id ?? null,
      barTypeCode: r.bt_code ?? null,
    };
  }

  private phaseView(r: Row): PhaseView {
    return {
      id: r.id,
      productionOrderId: r.production_order_id,
      phaseNumber: r.phase_number,
      status: r.status,
      operatorId: r.operator_id,
      operatorName: r.operator_name,
      machineId: r.machine_id,
      machineName: r.machine_name,
      partId: r.part_id,
      partCode: r.part_code,
      goodQty: r.good_qty,
      scrapQty: r.scrap_qty,
      setupStartedAt: iso(r.setup_started_at)!,
      setupEndedAt: iso(r.setup_ended_at),
      workStartedAt: iso(r.work_started_at),
      workEndedAt: iso(r.work_ended_at),
      avgUnitSeconds: numOrNull(r.avg_unit_seconds),
      resumedFromId: r.resumed_from_id,
      scheduleItemId: r.schedule_item_id,
      resumed: r.status === 'SUSPENDED' && !!r.resumed,
    };
  }

  private groupPhases(rows: Row[]): PhaseGroups {
    const views = rows.map((r) => this.phaseView(r));
    return {
      inProgress: views.filter((p) => p.status === 'IN_PROGRESS'),
      completed: views.filter((p) => p.status === 'COMPLETED'),
      suspended: views.filter((p) => p.status === 'SUSPENDED'),
    };
  }

  private stopView(r: Row): StopView {
    return {
      id: r.id, workPhaseId: r.work_phase_id, stopReasonId: r.stop_reason_id, stopReasonName: r.reason_name ?? null,
      machineStopped: !!r.machine_stopped, startedAt: iso(r.started_at)!, endedAt: iso(r.ended_at),
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Anagrafiche
  // ---------------------------------------------------------------------------------------------

  async stations(): Promise<StationView[]> {
    const rows: Row[] = await this.db.query(`
      SELECT m.id, m.name, mt.name AS type_name, COALESCE(mt.is_cutting, false) AS is_cutting, COALESCE(mt.is_inspection, false) AS is_inspection
      FROM machine m LEFT JOIN machine_type mt ON mt.id = m.machine_type_id
      WHERE m.deleted_at IS NULL
      ORDER BY m.sort_order, lower(m.name), m.id`);
    return rows.map((r) => ({ id: r.id, name: r.name, machineTypeName: r.type_name ?? '', isCutting: r.is_cutting, isInspection: r.is_inspection }));
  }

  async station(id: number): Promise<StationView> {
    const s = (await this.stations()).find((x) => x.id === id);
    if (!s) throw new NotFoundException('Postazione non trovata: scegli di nuovo la postazione');
    return s;
  }

  async operators(): Promise<OperatorView[]> {
    const rows: Row[] = await this.db.query(`
      SELECT o.id, o.first_name, o.last_name, (o.pin_hash IS NOT NULL AND o.pin_hash <> '') AS has_pin
      FROM operator o JOIN department dep ON dep.id = o.department_id AND dep.is_production
      WHERE o.deleted_at IS NULL AND o.active
      ORDER BY lower(o.first_name), lower(o.last_name), o.id`);
    return rows.map((r) => ({
      id: r.id, firstName: r.first_name, lastName: r.last_name, fullName: `${r.first_name} ${r.last_name}`.trim(), hasPin: r.has_pin,
    }));
  }

  /** Hash del PIN dell'operatore (colonna non selezionata di default). */
  async operatorPinHash(id: number): Promise<{ exists: boolean; pinHash: string | null }> {
    const rows: Row[] = await this.db.query(`
      SELECT o.pin_hash FROM operator o JOIN department dep ON dep.id = o.department_id AND dep.is_production
      WHERE o.id = $1 AND o.deleted_at IS NULL AND o.active`, [id]);
    return { exists: rows.length > 0, pinHash: rows[0]?.pin_hash || null };
  }

  async stopReasons(): Promise<StopReasonView[]> {
    const rows: Row[] = await this.db.query(`
      SELECT id, name, kind, ends_workday FROM stop_reason WHERE deleted_at IS NULL ORDER BY sort_order, lower(name), id`);
    return rows.map((r) => ({ id: r.id, name: r.name, kind: r.kind, endsWorkday: r.ends_workday }));
  }

  async extraActivities(): Promise<NamedItem[]> {
    return this.db.query(`SELECT id, name FROM extra_activity WHERE deleted_at IS NULL ORDER BY lower(name), id`);
  }

  // ---------------------------------------------------------------------------------------------
  // Prossimo particolare e scelta del lavoro
  // ---------------------------------------------------------------------------------------------

  /** Prossima lavorazione pianificata della macchina: prima quelle in lavorazione, poi le aperte per posizione. */
  async nextPlanned(machineId: number): Promise<NextPlannedView | null> {
    const rows: Row[] = await this.db.query(`
      SELECT si.id AS si_id, si.status AS si_status, si.setup_seconds, si.unit_seconds, ${ORDER_HEADER_SELECT}, ${PART_SELECT},
        ${QTY_PER_UNIT('po', 'si.part_id')} AS qty_per_unit
      FROM schedule_item si
      JOIN production_order po ON po.id = si.production_order_id
      JOIN customer_order co ON co.id = po.customer_order_id
      JOIN customer c ON c.id = co.customer_id
      JOIN drawing d ON d.id = po.drawing_id
      JOIN part pt ON pt.id = si.part_id ${PART_JOINS}
      WHERE si.machine_id = $1 AND si.deleted_at IS NULL AND si.status <> 'DONE'
        AND po.deleted_at IS NULL AND po.status <> 'COMPLETED'
      ORDER BY (si.status = 'IN_PROGRESS') DESC, si.position, si.id
      LIMIT 1`, [machineId]);
    const r = rows[0];
    if (!r) return null;
    return {
      scheduleItemId: r.si_id, status: r.si_status, order: this.orderHeader(r), part: this.partHeader(r),
      setupSeconds: num(r.setup_seconds), unitSeconds: num(r.unit_seconds),
    };
  }

  private async openOrdersOfCustomer(customerId: number): Promise<Row[]> {
    return this.db.query(`SELECT ${ORDER_HEADER_SELECT} ${OPEN_ORDERS_FROM} AND c.id = $1`, [customerId]);
  }

  /** Clienti con ordini non completati, in ordine alfabetico (stessi filtri dei sottogruppi). */
  async customers(): Promise<CustomerView[]> {
    const rows: Row[] = await this.db.query(`
      SELECT c.id, c.name, count(*)::int AS order_count ${OPEN_ORDERS_FROM}
      GROUP BY c.id, c.name`);
    return rows
      .map((r) => ({ id: r.id, name: r.name, orderCount: r.order_count }))
      .sort((a, b) => compareIt(a.name, b.name));
  }

  async subgroups(customerId: number): Promise<{ customer: NamedItem; subgroups: SubgroupView[] }> {
    const customer = await this.customer(customerId);
    const counts = new Map<string, number>();
    for (const r of await this.openOrdersOfCustomer(customerId)) {
      const sg = subgroupOf(r.co_code);
      counts.set(sg, (counts.get(sg) ?? 0) + 1);
    }
    const subgroups = [...counts.entries()].map(([name, orderCount]) => ({ name, orderCount })).sort((a, b) => compareIt(a.name, b.name));
    return { customer, subgroups };
  }

  private async customer(id: number): Promise<NamedItem> {
    const rows: Row[] = await this.db.query('SELECT id, name FROM customer WHERE id = $1', [id]);
    if (!rows[0]) throw new NotFoundException('Cliente non trovato');
    return rows[0] as NamedItem;
  }

  /** Ordini del cliente nel sottogruppo, raggruppati per materiale, ognuno una volta sola (A7). */
  async orders(customerId: number, subgroup: string): Promise<{ customer: NamedItem; subgroup: string; groups: OrderGroupView[] }> {
    const customer = await this.customer(customerId);
    const headers = (await this.openOrdersOfCustomer(customerId)).filter((r) => subgroupOf(r.co_code) === subgroup);
    const ids = headers.map((r) => r.po_id);
    const parts: Row[] = ids.length
      ? await this.db.query(`
        SELECT x.order_id, x.part_id, p.material_id, mat.name AS material_name
        FROM (
          SELECT pop.production_order_id AS order_id, pop.part_id FROM production_order_part pop WHERE pop.production_order_id = ANY($1)
          UNION
          SELECT po.id, dp.part_id FROM production_order po JOIN drawing_part dp ON dp.drawing_id = po.drawing_id
          WHERE po.id = ANY($1) AND NOT EXISTS (SELECT 1 FROM production_order_part q WHERE q.production_order_id = po.id)
        ) x
        JOIN part p ON p.id = x.part_id
        LEFT JOIN material mat ON mat.id = p.material_id`, [ids])
      : [];
    const items = headers.map((r) => {
      const own = parts.filter((p) => p.order_id === r.po_id).map((p) => ({ partId: p.part_id, materialId: p.material_id, materialName: p.material_name }));
      return {
        id: r.po_id, status: r.po_status, quantity: num(r.po_quantity), drawingId: r.po_drawing_id, drawingCode: r.d_code ?? '',
        drawingRevision: r.d_revision ?? '', customerOrderCode: r.co_code ?? '', expectedDeliveryDate: this.orderHeader(r).expectedDeliveryDate,
        partCount: new Set(own.map((p) => p.partId)).size, parts: own,
      };
    });
    const groups = groupOrdersByMaterial(items).map((g) => ({
      key: g.key,
      label: g.label,
      orders: g.orders.map(({ parts: _parts, ...o }) => o as OrderListItem),
    }));
    return { customer, subgroup, groups };
  }

  async orderHeaderById(orderId: number): Promise<OrderHeader> {
    const rows: Row[] = await this.db.query(`
      SELECT ${ORDER_HEADER_SELECT}
      FROM production_order po
      JOIN customer_order co ON co.id = po.customer_order_id
      JOIN customer c ON c.id = co.customer_id
      JOIN drawing d ON d.id = po.drawing_id
      WHERE po.id = $1 AND po.deleted_at IS NULL`, [orderId]);
    if (!rows[0]) throw new NotFoundException(`Ordine di produzione N. ${orderId} non trovato`);
    return this.orderHeader(rows[0]);
  }

  private async partHeaderFor(orderId: number, partId: number): Promise<PartHeader & { orderRow: Row }> {
    const rows: Row[] = await this.db.query(`
      SELECT po.quantity AS po_quantity, ${PART_SELECT}, ${QTY_PER_UNIT('po', 'pt.id')} AS qty_per_unit
      FROM production_order po JOIN part pt ON pt.id = $2 ${PART_JOINS}
      WHERE po.id = $1`, [orderId, partId]);
    if (!rows[0]) throw new NotFoundException('Particolare non trovato');
    return Object.assign(this.partHeader(rows[0]), { orderRow: rows[0] });
  }

  /** Particolari dell'ordine (tutti, anche quelli già finiti) con avanzamento. */
  async orderParts(orderId: number): Promise<{ order: OrderHeader; parts: OrderPartView[] }> {
    const order = await this.orderHeaderById(orderId);
    const rows: Row[] = await this.db.query(`
      WITH lines AS (
        SELECT pop.part_id, SUM(pop.quantity_per_unit) AS qty, MIN(pop.id) AS pos FROM production_order_part pop
        WHERE pop.production_order_id = $1 GROUP BY pop.part_id
      ), fallback AS (
        SELECT dp.part_id, SUM(dp.quantity) AS qty, MIN(dp.position) AS pos FROM production_order po
        JOIN drawing_part dp ON dp.drawing_id = po.drawing_id
        WHERE po.id = $1 AND NOT EXISTS (SELECT 1 FROM lines) GROUP BY dp.part_id
      ), allp AS (SELECT * FROM lines UNION ALL SELECT * FROM fallback)
      SELECT a.qty AS qty_per_unit, a.pos, po.quantity AS po_quantity, ${PART_SELECT},
        COALESCE((SELECT SUM(w.good_qty) FROM work_phase w WHERE w.deleted_at IS NULL AND w.production_order_id = $1 AND w.part_id = pt.id AND w.status <> 'IN_PROGRESS'), 0) AS good_done,
        (SELECT count(*) FROM work_phase w WHERE w.deleted_at IS NULL AND w.production_order_id = $1 AND w.part_id = pt.id AND w.status = 'IN_PROGRESS')::int AS open_phases
      FROM allp a JOIN production_order po ON po.id = $1 JOIN part pt ON pt.id = a.part_id ${PART_JOINS}
      ORDER BY a.pos, pt.internal_code`, [orderId]);
    return {
      order,
      parts: rows.map((r) => ({ ...this.partHeader(r), goodDone: num(r.good_done), openPhases: num(r.open_phases) })),
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Riassunti
  // ---------------------------------------------------------------------------------------------

  /** Riassunto ordine/particolare: fasi in corso, completate, sospese (con "già ripresa" corretto, A5). */
  async orderSummary(orderId: number, partId: number): Promise<OrderSummaryView> {
    const order = await this.orderHeaderById(orderId);
    const { orderRow: _r, ...part } = await this.partHeaderFor(orderId, partId);
    const rows: Row[] = await this.db.query(`${PHASE_SELECT}
      WHERE wp.deleted_at IS NULL AND wp.production_order_id = $1 AND wp.part_id = $2
      ORDER BY wp.setup_started_at, wp.id`, [orderId, partId]);
    return { order, part, phases: this.groupPhases(rows) };
  }

  /** Riassunto collaudo: fasi di tutti i particolari (numero fase e ripresa corretti, A1/A2), trattamenti, totali. */
  async inspectionSummary(orderId: number): Promise<InspectionSummaryView> {
    const order = await this.orderHeaderById(orderId);
    const phases: Row[] = await this.db.query(`${PHASE_SELECT}
      WHERE wp.deleted_at IS NULL AND wp.production_order_id = $1
      ORDER BY wp.setup_started_at, wp.id`, [orderId]);
    const treatments: Row[] = await this.db.query(`
      SELECT t.name FROM production_order_treatment pot JOIN treatment t ON t.id = pot.treatment_id WHERE pot.production_order_id = $1
      UNION
      SELECT t.name FROM production_order po JOIN drawing_treatment dt ON dt.drawing_id = po.drawing_id JOIN treatment t ON t.id = dt.treatment_id
      WHERE po.id = $1 AND NOT EXISTS (SELECT 1 FROM production_order_treatment x WHERE x.production_order_id = $1)`, [orderId]);
    const inspections = await this.inspections(`i.production_order_id = $1`, [orderId]);
    return {
      order,
      treatments: treatments.map((t) => t.name as string).sort(compareIt),
      phases: this.groupPhases(phases),
      totals: {
        goodQty: inspections.reduce((s, i) => s + (i.goodQty ?? 0), 0),
        scrapQty: inspections.reduce((s, i) => s + (i.scrapQty ?? 0), 0),
      },
      inspections,
    };
  }

  private async inspections(where: string, params: unknown[]): Promise<InspectionView[]> {
    const rows: Row[] = await this.db.query(`
      SELECT i.*, trim(op.first_name || ' ' || op.last_name) AS operator_name
      FROM inspection i JOIN operator op ON op.id = i.operator_id
      WHERE i.deleted_at IS NULL AND ${where}
      ORDER BY i.started_at, i.id`, params);
    return rows.map((r) => ({
      id: r.id, productionOrderId: r.production_order_id, operatorId: r.operator_id, operatorName: r.operator_name,
      startedAt: iso(r.started_at)!, endedAt: iso(r.ended_at), goodQty: r.good_qty, scrapQty: r.scrap_qty, notes: r.notes,
    }));
  }

  // ---------------------------------------------------------------------------------------------
  // Stato attuale (ripresa dopo un ricaricamento)
  // ---------------------------------------------------------------------------------------------

  async activePhase(phaseId: number): Promise<ActivePhaseView> {
    const rows: Row[] = await this.db.query(`${PHASE_SELECT} WHERE wp.id = $1`, [phaseId]);
    if (!rows[0]) throw new NotFoundException('Fase non trovata');
    return this.toActive(rows[0]);
  }

  private async toActive(r: Row): Promise<ActivePhaseView> {
    const phase = this.phaseView(r);
    const order = await this.orderHeaderById(phase.productionOrderId);
    const { orderRow: _o, ...part } = phase.partId
      ? await this.partHeaderFor(phase.productionOrderId, phase.partId)
      : { orderRow: {}, partId: 0, internalCode: '', name: '', materialName: null, quantityPerUnit: 1, totalQuantity: order.orderQuantity, barCut: false, barTypeId: null, barTypeCode: null };
    const stops: Row[] = await this.db.query(`
      SELECT s.*, sr.name AS reason_name FROM work_stop s LEFT JOIN stop_reason sr ON sr.id = s.stop_reason_id
      WHERE s.work_phase_id = $1 AND s.deleted_at IS NULL AND s.ended_at IS NULL ORDER BY s.id DESC LIMIT 1`, [phase.id]);
    return { phase, order, part, openStop: stops[0] ? this.stopView(stops[0]) : null };
  }

  async stopById(id: number): Promise<StopView> {
    const rows: Row[] = await this.db.query(`
      SELECT s.*, sr.name AS reason_name FROM work_stop s LEFT JOIN stop_reason sr ON sr.id = s.stop_reason_id WHERE s.id = $1`, [id]);
    if (!rows[0]) throw new NotFoundException('Fermo non trovato');
    return this.stopView(rows[0]);
  }

  async inspectionById(id: number): Promise<InspectionView & { order: OrderHeader }> {
    const [inspection] = await this.inspections('i.id = $1', [id]);
    if (!inspection) throw new NotFoundException('Collaudo non trovato');
    return { ...inspection, order: await this.orderHeaderById(inspection.productionOrderId) };
  }

  async extraById(id: number): Promise<ShopState['extraActivity']> {
    const rows: Row[] = await this.db.query(`
      SELECT l.id, l.extra_activity_id, l.started_at, l.ended_at, ea.name FROM extra_activity_log l
      JOIN extra_activity ea ON ea.id = l.extra_activity_id WHERE l.id = $1`, [id]);
    if (!rows[0]) throw new NotFoundException('Lavoro extra non trovato');
    return { id: rows[0].id, extraActivityId: rows[0].extra_activity_id, name: rows[0].name, startedAt: iso(rows[0].started_at)!, endedAt: iso(rows[0].ended_at) };
  }

  /**
   * Attività aperte di operatore e postazione, per riprendere dopo un ricaricamento del tablet.
   * Sono considerate solo quelle iniziate entro la finestra dell'impostazione "tablet_resume_max_hours":
   * le righe rimaste aperte da molto tempo (es. dati storici) si chiudono dal backoffice.
   */
  async state(machineId: number, operatorId?: number): Promise<ShopState> {
    const since = await this.actions.resumeSince();
    const phases: Row[] = await this.db.query(`${PHASE_SELECT}
      WHERE wp.deleted_at IS NULL AND wp.machine_id = $1 AND wp.status = 'IN_PROGRESS' AND wp.setup_started_at > $2
      ORDER BY wp.id DESC`, [machineId, since]);
    const mine = operatorId ? phases.find((p) => p.operator_id === operatorId) : undefined;
    const others = phases.filter((p) => p !== mine);
    const state: ShopState = {
      phase: mine ? await this.toActive(mine) : null,
      inspection: null,
      extraActivity: null,
      otherPhases: await Promise.all(others.map((p) => this.toActive(p))),
    };
    if (operatorId) {
      // Collaudo aperto, oppure chiuso da poco ma senza pezzi registrati (interrotto tra "Fine collaudo" e le note).
      const [insp] = await this.inspections(
        `i.operator_id = $1 AND i.machine_id = $2 AND i.started_at > $3
         AND (i.ended_at IS NULL OR (i.good_qty IS NULL AND i.ended_at > now() - interval '12 hours'))`,
        [operatorId, machineId, since],
      ).then((l) => l.reverse());
      if (insp) state.inspection = { ...insp, order: await this.orderHeaderById(insp.productionOrderId) };
      const extra: Row[] = await this.db.query(`
        SELECT l.id FROM extra_activity_log l WHERE l.deleted_at IS NULL AND l.operator_id = $1 AND l.ended_at IS NULL AND l.started_at > $2
        ORDER BY l.id DESC LIMIT 1`, [operatorId, since]);
      if (extra[0]) state.extraActivity = await this.extraById(extra[0].id);
    }
    return state;
  }

  // ---------------------------------------------------------------------------------------------
  // Taglio e magazzino barre
  // ---------------------------------------------------------------------------------------------

  /** Coda di taglio: righe non completate di ordini aperti, nell'ordine della coda. */
  async cutQueue(): Promise<CutQueueView[]> {
    const referenceMm = Number(await this.settings.get<number>('cut_reference_bar_mm', 500)) || 500;
    const extraMm = Number(await this.settings.get<number>('cut_bar_extra_mm', 40)) || 0;
    const rows: Row[] = await this.db.query(`
      SELECT cq.id AS cq_id, cq.position, cq.status AS cq_status, ${ORDER_HEADER_SELECT}, ${PART_SELECT},
        pt.dimensions, pt.shape AS pt_shape, pt.cut_length_mm, pt.notes AS pt_notes, bt.shape AS bt_shape, bs.meters AS stock_meters,
        COALESCE(
          (SELECT pop.quantity_per_unit FROM production_order_part pop WHERE pop.id = cq.production_order_part_id),
          ${QTY_PER_UNIT('po', 'cq.part_id')}) AS qty_per_unit
      FROM cut_queue_item cq
      JOIN production_order po ON po.id = cq.production_order_id AND po.deleted_at IS NULL AND po.status <> 'COMPLETED'
      JOIN customer_order co ON co.id = po.customer_order_id
      JOIN customer c ON c.id = co.customer_id
      JOIN drawing d ON d.id = po.drawing_id
      JOIN part pt ON pt.id = cq.part_id ${PART_JOINS}
      LEFT JOIN bar_stock bs ON bs.bar_type_id = pt.bar_type_id
      WHERE cq.deleted_at IS NULL AND cq.status <> 'COMPLETED'
      ORDER BY cq.position, cq.id`);
    return rows.map((r) => {
      const part = this.partHeader(r);
      const { shape, size } = splitDimensions(r.dimensions);
      const barShapeLabel = r.bt_shape ? BAR_SHAPES[r.bt_shape] ?? r.bt_shape : '';
      const plan = part.barCut
        ? barCutPlan(pieceLengthMm(numOrNull(r.cut_length_mm), r.dimensions), part.totalQuantity, referenceMm, extraMm)
        : null;
      return {
        id: r.cq_id,
        position: num(r.position),
        status: r.cq_status,
        order: this.orderHeader(r),
        part,
        shapeName: shape || barShapeLabel,
        shapeFamily: shapeFamily(r.bt_shape, r.pt_shape, r.dimensions),
        size,
        dimensions: r.dimensions ?? null,
        notes: r.pt_notes ?? null,
        barPlan: plan ? { ok: plan.ok, text: plan.text, bars: plan.bars, barLengthMm: plan.barLengthMm, piecesPerBar: plan.piecesPerBar } : null,
        stockMm: part.barTypeId ? metersToMm(r.stock_meters) : null,
      };
    });
  }

  async barTypes(): Promise<BarTypeView[]> {
    const rows: Row[] = await this.db.query(`
      SELECT bt.id, bt.code, bt.material_id, mat.name AS material_name, bt.finish_id, f.name AS finish_name, bt.shape, bt.dimensions,
        COALESCE(bs.meters, 0) AS meters
      FROM bar_type bt
      LEFT JOIN material mat ON mat.id = bt.material_id
      LEFT JOIN finish f ON f.id = bt.finish_id
      LEFT JOIN bar_stock bs ON bs.bar_type_id = bt.id
      WHERE bt.deleted_at IS NULL
      ORDER BY lower(bt.code)`);
    return rows.map((r) => ({
      id: r.id, code: r.code, materialId: r.material_id, materialName: r.material_name, finishId: r.finish_id, finishName: r.finish_name,
      shape: r.shape, shapeLabel: BAR_SHAPES[r.shape] ?? r.shape, dimensions: r.dimensions ?? '', stockMm: metersToMm(r.meters),
    }));
  }

  async barStock(barTypeId: number): Promise<{ barTypeId: number; code: string; stockMm: number }> {
    const rows: Row[] = await this.db.query(`
      SELECT bt.id, bt.code, COALESCE(bs.meters, 0) AS meters FROM bar_type bt LEFT JOIN bar_stock bs ON bs.bar_type_id = bt.id
      WHERE bt.id = $1`, [barTypeId]);
    if (!rows[0]) throw new NotFoundException('Tipologia di barra non trovata');
    return { barTypeId, code: rows[0].code, stockMm: metersToMm(rows[0].meters) };
  }
}
