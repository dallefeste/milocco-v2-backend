import { Injectable, NotFoundException } from '@nestjs/common';
import { eachDayOfInterval, format, parseISO } from 'date-fns';
import { DataSource } from 'typeorm';
import { PhaseDataService, PhaseRow, phaseRate } from './phase-data.service';
import { dateRange, drawingLabel, localDay, personName } from './report-utils';
import { costOf, percent, round2 } from './time-calc';

interface TimeBucket {
  setup: number;
  work: number;
  total: number;
  percent: number;
  /** Solo per ADMIN. */
  laborCost?: number;
}

export interface OrderBucket extends TimeBucket {
  productionOrderId: number;
  customerOrderId: number;
  customerOrderCode: string;
  drawing: string;
  quantity: number;
  phases: number;
}
export interface MachineBucket extends TimeBucket {
  machineId: number;
  machineName: string;
  machineType: string;
  orders: OrderBucket[];
}
export interface CustomerBucket extends TimeBucket {
  customerId: number;
  customerName: string;
  orders?: OrderBucket[];
  machines?: MachineBucket[];
}

/** Periodo oltre il quale il report operatore mostra solo i clienti (03-report §3.1). */
export const DETAIL_MAX_DAYS = 31;

/**
 * Report operatore (§3.1) e operatore-macchine (§3.2).
 * Fasi dell'operatore (non eliminate) con inizio attrezzaggio o inizio lavorazione nel periodo; si conta
 * l'intera fase. Tempi netti con la regola unica (time-calc). Costo manodopera = tempo netto × tariffa
 * oraria della macchina (tariffa per cliente se presente), visibile solo agli amministratori.
 */
@Injectable()
export class OperatorReportService {
  constructor(
    private readonly ds: DataSource,
    private readonly phases: PhaseDataService,
  ) {}

  async build(operatorId: number, q: { from?: string; to?: string }, opts: { byMachine: boolean; withCosts: boolean }) {
    const range = dateRange(q.from, q.to, opts.byMachine ? DETAIL_MAX_DAYS : undefined);
    const [op] = await this.ds.query(
      `SELECT o.id, o.first_name, o.last_name, o.active, d.name AS department FROM operator o LEFT JOIN department d ON d.id = o.department_id WHERE o.id = $1`,
      [operatorId],
    );
    if (!op) throw new NotFoundException('Operatore non trovato.');

    const list = await this.phases.load(
      `wp.operator_id = $1 AND ((wp.setup_started_at >= $2 AND wp.setup_started_at < $3) OR (wp.work_started_at >= $2 AND wp.work_started_at < $3))`,
      [operatorId, range.start, range.end],
    );
    const detailed = opts.byMachine || range.days <= DETAIL_MAX_DAYS;

    const cost = (p: PhaseRow) => costOf(p.times.total, phaseRate(p));
    const grandTotal = list.reduce((s, p) => s + p.times.total, 0);
    const bucket = (items: PhaseRow[]): TimeBucket => {
      const setup = items.reduce((s, p) => s + p.times.setupNet, 0);
      const work = items.reduce((s, p) => s + p.times.workNet, 0);
      const b: TimeBucket = { setup, work, total: setup + work, percent: percent(setup + work, grandTotal) };
      if (opts.withCosts) b.laborCost = round2(items.reduce((s, p) => s + cost(p), 0));
      return b;
    };
    const groupBy = <K>(items: PhaseRow[], key: (p: PhaseRow) => K) => {
      const m = new Map<K, PhaseRow[]>();
      for (const p of items) { const k = key(p); const l = m.get(k) ?? []; l.push(p); m.set(k, l); }
      return [...m.entries()];
    };
    const ordersOf = (items: PhaseRow[]): OrderBucket[] =>
      groupBy(items, (p) => p.productionOrderId)
        .map(([, ps]) => ({
          productionOrderId: ps[0].productionOrderId,
          customerOrderId: ps[0].customerOrderId,
          customerOrderCode: ps[0].customerOrderCode,
          drawing: drawingLabel(ps[0].drawingCode, ps[0].drawingRevision),
          quantity: ps[0].orderQuantity,
          phases: ps.length,
          ...bucket(ps),
        }))
        .sort((a, b) => b.total - a.total);

    const customers: CustomerBucket[] = groupBy(list, (p) => p.customerId)
      .map(([, ps]) => {
        const c: CustomerBucket = { customerId: ps[0].customerId, customerName: ps[0].customerName, ...bucket(ps) };
        if (opts.byMachine) {
          c.machines = groupBy(ps, (p) => p.machineId)
            .map(([, ms]) => ({ machineId: ms[0].machineId, machineName: ms[0].machineName, machineType: ms[0].machineTypeName, ...bucket(ms), orders: ordersOf(ms) }))
            .sort((a, b) => b.total - a.total);
        } else if (detailed) {
          c.orders = ordersOf(ps);
        }
        return c;
      })
      .sort((a, b) => b.total - a.total);

    // Pause: fermi con causale di tipo pausa delle fasi selezionate.
    const pauseSeconds = list.reduce((s, p) => s + p.times.pauseSeconds, 0);
    const machineStopSeconds = list.reduce((s, p) => s + p.times.machineStopSeconds, 0);

    // Lavori extra iniziati nel periodo (chiusi e con orari coerenti).
    const extraRows: { name: string; seconds: string; count: string }[] = await this.ds.query(
      `SELECT ea.name, sum(extract(epoch FROM x.ended_at - x.started_at))::bigint AS seconds, count(*) AS count
         FROM extra_activity_log x JOIN extra_activity ea ON ea.id = x.extra_activity_id
        WHERE x.deleted_at IS NULL AND x.operator_id = $1 AND x.started_at >= $2 AND x.started_at < $3
          AND x.ended_at IS NOT NULL AND x.ended_at >= x.started_at
        GROUP BY ea.name ORDER BY 2 DESC`,
      [operatorId, range.start, range.end],
    );
    const extraActivities = extraRows.map((r) => ({ name: r.name, seconds: Number(r.seconds), count: Number(r.count) }));
    const extraSeconds = extraActivities.reduce((s, r) => s + r.seconds, 0);

    // Andamento per giorno (giorno di inizio della fase).
    const days = new Map(eachDayOfInterval({ start: parseISO(range.from), end: parseISO(range.to) }).map((d) => [format(d, 'yyyy-MM-dd'), { day: format(d, 'yyyy-MM-dd'), setup: 0, work: 0 }]));
    for (const p of list) {
      const d = days.get(localDay(p.setupStartedAt)) ?? days.get(localDay(p.workStartedAt ?? p.setupStartedAt));
      if (d) { d.setup += p.times.setupNet; d.work += p.times.workNet; }
    }

    const totals: Record<string, number> = {
      setup: list.reduce((s, p) => s + p.times.setupNet, 0),
      work: list.reduce((s, p) => s + p.times.workNet, 0),
      total: grandTotal,
      pause: pauseSeconds,
      machineStop: machineStopSeconds,
      extra: extraSeconds,
      phases: list.length,
      openPhases: list.filter((p) => p.times.open).length,
      invalidPhases: list.filter((p) => p.times.invalid).length,
    };
    if (opts.withCosts) totals.laborCost = round2(list.reduce((s, p) => s + cost(p), 0));

    return {
      operator: { id: op.id, name: personName(op.first_name, op.last_name), department: op.department, active: op.active },
      from: range.from,
      to: range.to,
      days: range.days,
      detailed,
      withCosts: opts.withCosts,
      totals,
      customers,
      extraActivities,
      byDay: [...days.values()],
    };
  }
}
