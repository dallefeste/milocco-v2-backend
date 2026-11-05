import { Injectable, NotFoundException } from '@nestjs/common';
import { format, parseISO, subDays } from 'date-fns';
import { DataSource } from 'typeorm';
import { PhaseDataService, PhaseRow, phaseRate } from './phase-data.service';
import { drawingLabel, personName } from './report-utils';
import { costOf, percent, round2 } from './time-calc';

export type StepState = 'DONE' | 'IN_PROGRESS' | 'TODO';

interface OrderPartRow { production_order_id: number; part_id: number; quantity_per_unit: number; internal_code: string; name: string; weight_kg: string | null; price_per_kg: string | null; material_name: string | null }
interface CycleRow { part_id: number; machine_type_id: number; machine_type_name: string; sequence: number; is_inspection: boolean }

export interface ProgressStep {
  partId: number;
  partCode: string;
  machineTypeId: number;
  machineTypeName: string;
  sequence: number;
  /** Fase di collaudo: coperta dai collaudi registrati, non dalle fasi macchina. */
  isInspection?: boolean;
  state: StepState;
  phaseId: number | null;
  /** Ordine completato senza fase registrata: data per fatta. */
  assumed?: boolean;
}

/**
 * Avanzamento: confronto tra ciclo previsto (fasi del ciclo di ogni particolare dell'ordine) e fasi
 * registrate (i collaudi registrati coprono le fasi del ciclo di tipo collaudo).
 * Ogni fase del ciclo vale 1 se coperta da una fase conclusa, 0,5 se coperta da una fase in corso o
 * sospesa (e non ripresa), 0 altrimenti. Abbinamento: prima stessa tipologia macchina e stesso
 * particolare; poi, per le fasi registrate su una tipologia diversa dal ciclo, la prima fase libera dello
 * stesso particolare. Una fase registrata copre una sola fase del ciclo: la percentuale non supera mai il
 * 100%; le fasi in più sono contate a parte. Ordine completato = 100% (le fasi non registrate sono
 * segnate come "date per fatte").
 */
export function matchProgress(steps: Omit<ProgressStep, 'state' | 'phaseId'>[], phases: Pick<PhaseRow, 'id' | 'partId' | 'machineTypeId' | 'status' | 'resumedFromId' | 'setupStartedAt'>[], orderCompleted = false) {
  const resumed = new Set(phases.map((p) => p.resumedFromId).filter((v): v is number => !!v));
  const effective = phases.filter((p) => !resumed.has(p.id)).sort((a, b) => new Date(a.setupStartedAt).getTime() - new Date(b.setupStartedAt).getTime());
  const out: ProgressStep[] = steps.map((s) => ({ ...s, state: 'TODO', phaseId: null }));
  const used = new Set<number>();
  const pass = (list: typeof effective, state: StepState, sameType: boolean) => {
    for (const p of list) {
      if (used.has(p.id)) continue;
      // Collaudi (id negativi) solo sulle fasi di collaudo; le fasi macchina mai sulle fasi di collaudo.
      if (!sameType && p.id < 0) continue;
      const step = out.find((s) => s.state === 'TODO' && (sameType ? s.machineTypeId === p.machineTypeId : !s.isInspection) && (p.partId === null || s.partId === p.partId));
      if (step) { step.state = state; step.phaseId = p.id; used.add(p.id); }
    }
  };
  const done = effective.filter((x) => x.status === 'COMPLETED');
  const open = effective.filter((x) => x.status !== 'COMPLETED');
  pass(done, 'DONE', true);
  pass(open, 'IN_PROGRESS', true);
  pass(done, 'DONE', false);
  pass(open, 'IN_PROGRESS', false);
  if (orderCompleted) for (const s of out) if (s.state !== 'DONE') { s.state = 'DONE'; s.assumed = true; }
  const weight = out.reduce((s, x) => s + (x.state === 'DONE' ? 1 : x.state === 'IN_PROGRESS' ? 0.5 : 0), 0);
  const expected = out.length;
  const progress = orderCompleted ? 1 : expected > 0 ? Math.round((weight / expected) * 100) / 100 : 0;
  return { steps: out, weight, expected, progress, unmatchedPhases: effective.filter((p) => p.id > 0 && !used.has(p.id)).length };
}

/**
 * Report ordine cliente (03-report §4): avanzamento, costi (solo ADMIN) e trattamenti in un'unica lettura.
 */
@Injectable()
export class CustomerOrderReportService {
  constructor(
    private readonly ds: DataSource,
    private readonly phaseData: PhaseDataService,
  ) {}

  private async load(id: number) {
    const [co] = await this.ds.query(
      `SELECT co.id, co.code, co.order_date, co.notes, co.customer_id, c.name AS customer_name
         FROM customer_order co JOIN customer c ON c.id = co.customer_id
        WHERE co.id = $1 AND co.deleted_at IS NULL`,
      [id],
    );
    if (!co) throw new NotFoundException('Ordine cliente non trovato.');
    const orders: any[] = await this.ds.query(
      `SELECT po.id, po.quantity, po.stock_quantity, po.status, po.expected_delivery_date::text AS expected_delivery_date, po.started_at, po.completed_at, po.notes,
              po.drawing_id, d.code AS drawing_code, d.revision AS drawing_revision, d.name AS drawing_name
         FROM production_order po JOIN drawing d ON d.id = po.drawing_id
        WHERE po.customer_order_id = $1 AND po.deleted_at IS NULL
        ORDER BY po.id`,
      [id],
    );
    const ids = orders.map((o) => o.id);
    // Particolari dell'ordine; se l'ordine non li ha (dati storici) si usano quelli del disegno.
    const parts: OrderPartRow[] = ids.length
      ? await this.ds.query(
          `SELECT x.production_order_id, x.part_id, x.quantity_per_unit, p.internal_code, p.name, p.weight_kg, mat.price_per_kg, mat.name AS material_name
             FROM (
               SELECT pop.production_order_id, pop.part_id, pop.quantity_per_unit, pop.id AS ord
                 FROM production_order_part pop WHERE pop.production_order_id = ANY($1)
               UNION ALL
               SELECT po.id, dp.part_id, dp.quantity, dp.position
                 FROM production_order po JOIN drawing_part dp ON dp.drawing_id = po.drawing_id
                WHERE po.id = ANY($1) AND NOT EXISTS (SELECT 1 FROM production_order_part pop WHERE pop.production_order_id = po.id)
             ) x
             JOIN part p ON p.id = x.part_id
             LEFT JOIN material mat ON mat.id = p.material_id
            ORDER BY x.production_order_id, x.ord`,
          [ids],
        )
      : [];
    const partIds = [...new Set(parts.map((p) => p.part_id))];
    const cycle: CycleRow[] = partIds.length
      ? await this.ds.query(
          `SELECT s.part_id, s.machine_type_id, mt.name AS machine_type_name, s.sequence, mt.is_inspection
             FROM part_cycle_step s JOIN machine_type mt ON mt.id = s.machine_type_id
            WHERE s.part_id = ANY($1) ORDER BY s.part_id, s.sequence, s.id`,
          [partIds],
        )
      : [];
    const phases = ids.length ? await this.phaseData.load('wp.production_order_id = ANY($1)', [ids]) : [];
    const inspections: { id: number; production_order_id: number; started_at: Date; ended_at: Date | null }[] = ids.length
      ? await this.ds.query(
          `SELECT id, production_order_id, started_at, ended_at FROM inspection WHERE production_order_id = ANY($1) AND deleted_at IS NULL`,
          [ids],
        )
      : [];
    return { co, orders, parts, cycle, phases, inspections };
  }

  private header(co: any) {
    return { id: co.id, code: co.code, orderDate: co.order_date, notes: co.notes, customerId: co.customer_id, customerName: co.customer_name };
  }

  private progressOf(order: any, parts: OrderPartRow[], cycle: CycleRow[], phases: PhaseRow[], inspections: { id: number; production_order_id: number; started_at: Date; ended_at: Date | null }[]) {
    const steps = parts
      .filter((p) => p.production_order_id === order.id)
      .flatMap((p) =>
        cycle
          .filter((c) => c.part_id === p.part_id)
          .map((c) => ({ partId: p.part_id, partCode: p.internal_code, machineTypeId: c.machine_type_id, machineTypeName: c.machine_type_name, sequence: c.sequence, isInspection: c.is_inspection })),
      );
    const inspectionType = steps.find((s) => s.isInspection)?.machineTypeId ?? -1;
    const pseudo = inspections
      .filter((i) => i.production_order_id === order.id)
      .map((i) => ({ id: -i.id, partId: null, machineTypeId: inspectionType, status: (i.ended_at ? 'COMPLETED' : 'IN_PROGRESS') as PhaseRow['status'], resumedFromId: null, setupStartedAt: i.started_at }));
    return matchProgress(steps, [...phases.filter((p) => p.productionOrderId === order.id), ...pseudo], order.status === 'COMPLETED');
  }

  /** Avanzamento e trattamenti (ADMIN e OFFICE). */
  async overview(id: number) {
    const { co, orders, parts, cycle, phases, inspections } = await this.load(id);
    const ids = orders.map((o) => o.id);
    const treatments: { production_order_id: number; name: string; required_days: number; source: string }[] = ids.length
      ? await this.ds.query(
          `SELECT pot.production_order_id, t.name, t.required_days, 'ORDER' AS source
             FROM production_order_treatment pot JOIN treatment t ON t.id = pot.treatment_id
            WHERE pot.production_order_id = ANY($1)
           UNION ALL
           SELECT po.id, t.name, t.required_days, 'DRAWING'
             FROM production_order po JOIN drawing_treatment dt ON dt.drawing_id = po.drawing_id JOIN treatment t ON t.id = dt.treatment_id
            WHERE po.id = ANY($1) AND NOT EXISTS (SELECT 1 FROM production_order_treatment x WHERE x.production_order_id = po.id)
           ORDER BY 1, 2`,
          [ids],
        )
      : [];

    let weight = 0;
    let expected = 0;
    const productionOrders = orders.map((o) => {
      const pr = this.progressOf(o, parts, cycle, phases, inspections);
      weight += pr.weight;
      expected += pr.expected;
      const own = phases.filter((p) => p.productionOrderId === o.id);
      const tr = treatments.filter((t) => t.production_order_id === o.id);
      const days = tr.reduce((s, t) => s + (t.required_days ?? 0), 0);
      const sendBy = o.expected_delivery_date && tr.length ? format(subDays(parseISO(o.expected_delivery_date), days), 'yyyy-MM-dd') : null;
      return {
        id: o.id as number,
        drawingId: o.drawing_id as number,
        drawing: drawingLabel(o.drawing_code, o.drawing_revision),
        drawingName: o.drawing_name as string,
        quantity: o.quantity as number,
        stockQuantity: o.stock_quantity as number,
        status: o.status as string,
        expectedDeliveryDate: o.expected_delivery_date as string | null,
        startedAt: o.started_at as Date | null,
        completedAt: o.completed_at as Date | null,
        progress: pr.progress,
        expectedSteps: pr.expected,
        steps: pr.steps,
        unmatchedPhases: pr.unmatchedPhases,
        phases: own.map((p) => ({
          id: p.id, phaseNumber: p.phaseNumber, partCode: p.partCode, machineType: p.machineTypeName, machine: p.machineName,
          operator: personName(p.operatorFirstName, p.operatorLastName), status: p.status, setupStartedAt: p.setupStartedAt,
          workEndedAt: p.workEndedAt, goodQty: p.goodQty, scrapQty: p.scrapQty, total: p.times.total,
        })),
        treatments: tr.map((t) => ({ name: t.name, requiredDays: t.required_days, source: t.source })),
        treatmentDays: days,
        treatmentSendBy: sendBy,
      };
    });
    const allCompleted = orders.length > 0 && orders.every((o) => o.status === 'COMPLETED');
    return {
      customerOrder: this.header(co),
      progress: allCompleted ? 1 : expected > 0 ? Math.round((weight / expected) * 100) / 100 : 0,
      productionOrders,
    };
  }

  /** Costi (solo ADMIN). */
  async costs(id: number) {
    const { co, orders, parts, phases } = await this.load(id);
    const rows = orders.map((o) => {
      const own = phases.filter((p) => p.productionOrderId === o.id);
      const ownParts = parts.filter((p) => p.production_order_id === o.id);
      // Materiale dell'intero ordine: peso × €/kg × pezzi per unità × quantità ordine.
      const material = ownParts.reduce((s, p) => s + Number(p.weight_kg ?? 0) * Number(p.price_per_kg ?? 0) * (p.quantity_per_unit ?? 1) * o.quantity, 0);
      const missingMaterial = ownParts.filter((p) => !(Number(p.weight_kg) > 0) || !(Number(p.price_per_kg) > 0)).map((p) => p.internal_code);
      const types = new Map<number, { machineTypeId: number; machineTypeName: string; setup: number; work: number; cost: number; machines: Map<number, { machineId: number; machineName: string; rate: number; customerRate: boolean; seconds: number; cost: number }> }>();
      for (const p of own) {
        const t = types.get(p.machineTypeId) ?? { machineTypeId: p.machineTypeId, machineTypeName: p.machineTypeName, setup: 0, work: 0, cost: 0, machines: new Map() };
        const rate = phaseRate(p);
        const c = costOf(p.times.total, rate);
        t.setup += p.times.setupNet;
        t.work += p.times.workNet;
        t.cost += c;
        const m = t.machines.get(p.machineId) ?? { machineId: p.machineId, machineName: p.machineName, rate, customerRate: p.customerRate !== null, seconds: 0, cost: 0 };
        m.seconds += p.times.total;
        m.cost += c;
        t.machines.set(p.machineId, m);
        types.set(p.machineTypeId, t);
      }
      const labor = round2([...types.values()].reduce((s, t) => s + t.cost, 0));
      const materialCost = round2(material);
      const total = round2(labor + materialCost);
      return {
        id: o.id as number,
        drawing: drawingLabel(o.drawing_code, o.drawing_revision),
        quantity: o.quantity as number,
        status: o.status as string,
        laborCost: labor,
        materialCost,
        totalCost: total,
        unitCost: o.quantity > 0 ? round2(total / o.quantity) : null,
        missingMaterial,
        percent: 0,
        byMachineType: [...types.values()]
          .map((t) => ({ ...t, cost: round2(t.cost), machines: [...t.machines.values()].map((m) => ({ ...m, cost: round2(m.cost) })) }))
          .sort((a, b) => b.cost - a.cost),
      };
    });
    const laborTotal = round2(rows.reduce((s, r) => s + r.laborCost, 0));
    for (const r of rows) r.percent = percent(r.laborCost, laborTotal);
    rows.sort((a, b) => b.percent - a.percent || a.id - b.id);
    const materialTotal = round2(rows.reduce((s, r) => s + r.materialCost, 0));
    return {
      customerOrder: this.header(co),
      productionOrders: rows,
      totals: { laborCost: laborTotal, materialCost: materialTotal, totalCost: round2(laborTotal + materialTotal) },
    };
  }
}
