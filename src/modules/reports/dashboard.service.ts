import { Injectable } from '@nestjs/common';
import { addDays, format, parseISO, subDays } from 'date-fns';
import { DataSource } from 'typeorm';
import { ProductionCountersService } from '../production/production-counters.service';
import { SalesCountersService } from '../sales/sales-counters.service';
import { DrawingsService } from '../technical/drawings.service';
import { PhaseDataService } from './phase-data.service';
import { dayBounds, drawingLabel, parseDay, personName, todayLocal, TZ } from './report-utils';

export interface DashboardCounters {
  customerOrdersToConfirm: number;
  drawingsToComplete: number;
  cutToApprove: number;
  openPhases: number;
  lateOrders: number;
}

/** Giorni dopo i quali una fase aperta è considerata "dimenticata" e non compare in "Reparto adesso". */
const LIVE_WINDOW_DAYS = 7;

/** Cruscotto della home e contatori del menu. */
@Injectable()
export class DashboardService {
  constructor(
    private readonly ds: DataSource,
    private readonly phases: PhaseDataService,
    private readonly drawings: DrawingsService,
    private readonly sales: SalesCountersService,
    private readonly production: ProductionCountersService,
  ) {}

  /**
   * Contatori del menu: ogni area calcola i propri con la stessa regola delle sue liste,
   * così il numero del badge coincide con quello che si vede aprendo la pagina.
   */
  async counters(): Promise<DashboardCounters> {
    const [customerOrdersToConfirm, drawingsToComplete, prod] = await Promise.all([
      this.sales.customerOrdersToConfirm(),
      this.drawings.countToComplete(),
      this.production.counters(),
    ]);
    return { customerOrdersToConfirm, drawingsToComplete, ...prod };
  }

  /**
   * Dati della home. `at` (AAAA-MM-GG) permette di vedere il cruscotto come era in un giorno passato
   * (utile per verifiche sui dati storici); predefinito oggi.
   */
  async overview(at?: string) {
    const today = parseDay(at, todayLocal());
    const isToday = today === todayLocal();
    const ref = isToday ? new Date() : dayBounds(today).end;
    const in7 = format(addDays(parseISO(today), 7), 'yyyy-MM-dd');

    const orderCols = `po.id, po.quantity, po.status, po.expected_delivery_date::text AS expected_delivery_date,
      d.code AS drawing_code, d.revision AS drawing_revision, co.id AS customer_order_id, co.code AS customer_order_code, c.name AS customer_name,
      ($1::date - po.expected_delivery_date) AS days_late`;
    const orderFrom = `FROM production_order po JOIN drawing d ON d.id = po.drawing_id
      JOIN customer_order co ON co.id = po.customer_order_id JOIN customer c ON c.id = co.customer_id
      WHERE po.deleted_at IS NULL AND po.status <> 'COMPLETED'`;
    const late: any[] = await this.ds.query(`SELECT ${orderCols} ${orderFrom} AND po.expected_delivery_date < $1::date ORDER BY po.expected_delivery_date, po.id LIMIT 15`, [today]);
    const dueSoon: any[] = await this.ds.query(
      `SELECT ${orderCols} ${orderFrom} AND po.expected_delivery_date >= $1::date AND po.expected_delivery_date <= $2::date ORDER BY po.expected_delivery_date, po.id LIMIT 20`,
      [today, in7],
    );
    const [counts] = await this.ds.query(
      `SELECT count(*) FILTER (WHERE po.expected_delivery_date < $1::date) AS late,
              count(*) FILTER (WHERE po.expected_delivery_date >= $1::date AND po.expected_delivery_date <= $2::date) AS due_soon
         FROM production_order po WHERE po.deleted_at IS NULL AND po.status <> 'COMPLETED'`,
      [today, in7],
    );
    const mapOrder = (o: any) => ({
      id: o.id as number,
      drawing: drawingLabel(o.drawing_code, o.drawing_revision),
      quantity: o.quantity as number,
      status: o.status as string,
      expectedDeliveryDate: o.expected_delivery_date as string,
      customerOrderId: o.customer_order_id as number,
      customerOrderCode: o.customer_order_code as string,
      customerName: o.customer_name as string,
      daysLate: Number(o.days_late),
    });

    // Carico macchine: ore pianificate ancora da fare sulle lavorazioni aperte (stima: per quelle in
    // corso si toglie l'attrezzaggio se già fatto e i pezzi buoni già prodotti).
    const load: any[] = await this.ds.query(
      `SELECT m.id, m.name, mt.name AS machine_type, count(si.id) AS items,
              coalesce(sum(CASE WHEN si.status = 'IN_PROGRESS'
                     THEN (CASE WHEN x.setup_done THEN 0 ELSE si.setup_seconds END) + si.unit_seconds * greatest(0, si.quantity - coalesce(x.good, 0))
                     ELSE si.setup_seconds + si.unit_seconds * si.quantity END), 0) AS seconds
         FROM machine m
         JOIN machine_type mt ON mt.id = m.machine_type_id
         LEFT JOIN schedule_item si ON si.machine_id = m.id AND si.deleted_at IS NULL AND si.status IN ('OPEN', 'IN_PROGRESS')
              AND EXISTS (SELECT 1 FROM production_order po WHERE po.id = si.production_order_id AND po.deleted_at IS NULL AND po.status <> 'COMPLETED')
         LEFT JOIN LATERAL (SELECT bool_or(wp.setup_ended_at IS NOT NULL) AS setup_done, sum(wp.good_qty) AS good
                              FROM work_phase wp WHERE wp.schedule_item_id = si.id AND wp.deleted_at IS NULL) x ON true
        WHERE m.deleted_at IS NULL AND m.schedulable
        GROUP BY m.id, m.name, mt.name, m.sort_order
        ORDER BY m.sort_order, m.name`,
    );

    // Reparto adesso: fasi aperte recenti (le più vecchie sono contate a parte).
    const since = subDays(ref, LIVE_WINDOW_DAYS);
    const open = await this.phases.load(`wp.status = 'IN_PROGRESS' AND wp.setup_started_at >= $1 AND wp.setup_started_at <= $2`, [since, ref], {
      openUntil: ref,
      orderBy: 'wp.setup_started_at DESC',
    });
    const [stale] = await this.ds.query(
      `SELECT count(*) AS n FROM work_phase WHERE status = 'IN_PROGRESS' AND deleted_at IS NULL AND setup_started_at < $1`,
      [since],
    );
    const openInspections: any[] = await this.ds.query(
      `SELECT i.id, i.production_order_id, i.started_at, o.first_name, o.last_name, d.code AS drawing_code, d.revision AS drawing_revision
         FROM inspection i JOIN operator o ON o.id = i.operator_id JOIN production_order po ON po.id = i.production_order_id JOIN drawing d ON d.id = po.drawing_id
        WHERE i.deleted_at IS NULL AND i.ended_at IS NULL AND i.started_at >= $1 AND i.started_at <= $2 ORDER BY i.started_at DESC LIMIT 20`,
      [since, ref],
    );
    const openExtras: any[] = await this.ds.query(
      `SELECT x.id, x.started_at, o.first_name, o.last_name, ea.name AS activity, m.name AS machine_name
         FROM extra_activity_log x JOIN operator o ON o.id = x.operator_id JOIN extra_activity ea ON ea.id = x.extra_activity_id LEFT JOIN machine m ON m.id = x.machine_id
        WHERE x.deleted_at IS NULL AND x.ended_at IS NULL AND x.started_at >= $1 AND x.started_at <= $2 ORDER BY x.started_at DESC LIMIT 20`,
      [since, ref],
    );

    // Produzione ultimi 30 giorni: pezzi delle fasi concluse e dei collaudi, per giorno.
    const from30 = format(subDays(parseISO(today), 29), 'yyyy-MM-dd');
    const production: any[] = await this.ds.query(
      `SELECT to_char(g.day, 'YYYY-MM-DD') AS day, coalesce(p.good, 0) AS good, coalesce(p.scrap, 0) AS scrap, coalesce(p.phases, 0) AS phases,
              coalesce(i.good, 0) AS inspected_good, coalesce(i.scrap, 0) AS inspected_scrap
         FROM generate_series($1::date, $2::date, interval '1 day') AS g(day)
         LEFT JOIN (SELECT (wp.work_ended_at AT TIME ZONE $3)::date AS day, sum(wp.good_qty) AS good, sum(wp.scrap_qty) AS scrap, count(*) AS phases
                      FROM work_phase wp WHERE wp.deleted_at IS NULL AND wp.work_ended_at >= $4 AND wp.work_ended_at < $5 GROUP BY 1) p ON p.day = g.day::date
         LEFT JOIN (SELECT (i.ended_at AT TIME ZONE $3)::date AS day, sum(i.good_qty) AS good, sum(i.scrap_qty) AS scrap
                      FROM inspection i WHERE i.deleted_at IS NULL AND i.ended_at >= $4 AND i.ended_at < $5 GROUP BY 1) i ON i.day = g.day::date
        ORDER BY g.day`,
      [from30, today, TZ, dayBounds(from30).start, dayBounds(today).end],
    );

    const latest: any[] = await this.ds.query(
      `SELECT co.id, co.code, co.order_date, c.name AS customer_name,
              count(l.id) AS lines, count(l.id) FILTER (WHERE l.status = 'PENDING') AS pending,
              count(l.id) FILTER (WHERE l.status = 'PENDING' AND EXISTS (
                SELECT 1 FROM drawing_part dp WHERE dp.drawing_id = l.drawing_id AND NOT EXISTS (SELECT 1 FROM part_cycle_step s WHERE s.part_id = dp.part_id))) AS incomplete
         FROM customer_order co JOIN customer c ON c.id = co.customer_id
         LEFT JOIN customer_order_line l ON l.customer_order_id = co.id AND l.deleted_at IS NULL
        WHERE co.deleted_at IS NULL AND co.order_date < $1
        GROUP BY co.id, c.name ORDER BY co.order_date DESC, co.id DESC LIMIT 8`,
      [dayBounds(today).end],
    );

    return {
      day: today,
      isToday,
      counters: await this.counters(),
      lateOrders: { total: Number(counts.late), items: late.map(mapOrder) },
      dueSoon: { total: Number(counts.due_soon), items: dueSoon.map(mapOrder) },
      machineLoad: load.map((m) => ({ machineId: m.id as number, machineName: m.name as string, machineType: m.machine_type as string, items: Number(m.items), seconds: Number(m.seconds) })),
      shopNow: {
        phases: open.map((p) => {
          const openStop = p.stops.find((s) => !s.endedAt);
          return {
            id: p.id,
            operatorId: p.operatorId,
            operator: personName(p.operatorFirstName, p.operatorLastName),
            machineId: p.machineId,
            machine: p.machineName,
            machineType: p.machineTypeName,
            productionOrderId: p.productionOrderId,
            drawing: drawingLabel(p.drawingCode, p.drawingRevision),
            partCode: p.partCode,
            customerName: p.customerName,
            stage: p.workStartedAt ? 'WORK' : 'SETUP',
            since: p.workStartedAt ?? p.setupStartedAt,
            netSeconds: p.times.total,
            goodQty: p.goodQty,
            plannedQty: p.orderQuantity * (p.quantityPerUnit ?? 1),
            openStop: openStop ? { reason: openStop.reasonName ?? 'Fermo', since: openStop.startedAt, machineStopped: openStop.machineStopped } : null,
          };
        }),
        inspections: openInspections.map((i) => ({ id: i.id, productionOrderId: i.production_order_id, operator: personName(i.first_name, i.last_name), drawing: drawingLabel(i.drawing_code, i.drawing_revision), since: i.started_at })),
        extras: openExtras.map((x) => ({ id: x.id, operator: personName(x.first_name, x.last_name), activity: x.activity, machine: x.machine_name, since: x.started_at })),
        staleOpenPhases: Number(stale.n),
        windowDays: LIVE_WINDOW_DAYS,
      },
      production: production.map((p) => ({
        day: p.day as string,
        good: Number(p.good),
        scrap: Number(p.scrap),
        phases: Number(p.phases),
        inspectedGood: Number(p.inspected_good),
        inspectedScrap: Number(p.inspected_scrap),
      })),
      latestCustomerOrders: latest.map((c) => {
        const lines = Number(c.lines);
        const pending = Number(c.pending);
        const status = Number(c.incomplete) > 0 ? 'INCOMPLETE' : pending === 0 && lines > 0 ? 'CONFIRMED' : pending === lines ? 'TO_CONFIRM' : 'PARTIALLY_CONFIRMED';
        return { id: c.id as number, code: c.code as string, orderDate: c.order_date as Date, customerName: c.customer_name as string, lines, pending, status };
      }),
    };
  }
}
