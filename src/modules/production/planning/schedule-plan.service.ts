import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import { DataSource, In, MoreThanOrEqual } from 'typeorm';
import { Machine, WorkCalendarClosure, WorkCalendarDay, WorkPhase } from '../../../entities';
import { effectiveStatusSql, todayIn } from '../common/production-db';
import { CalendarError, PlanJob, WorkingTime, addDays, phaseWorkedSeconds, planMachine } from './schedule-plan';

interface PlanRow {
  id: number;
  machine_id: number;
  eff: 'OPEN' | 'IN_PROGRESS';
  position: number;
  setup_seconds: number;
  unit_seconds: number;
  internal_pause_seconds: number;
  end_pause_seconds: number;
  quantity: number;
  production_order_id: number;
  order_quantity: number;
  expected_delivery_date: string | null;
  order_status: string;
  drawing_code: string | null;
  drawing_revision: string | null;
  customer_order_code: string | null;
  customer_name: string | null;
  part_id: number;
  part_code: string;
  part_name: string;
}

@Injectable()
export class SchedulePlanService {
  private readonly timeZone: string;

  constructor(@InjectDataSource() private readonly dataSource: DataSource, config: ConfigService) {
    this.timeZone = config.get<string>('timezone') ?? 'Europe/Rome';
  }

  /** Orario di lavoro e chiusure straordinarie da oggi in poi (letti direttamente dalle tabelle dell'orario). */
  async workingTime(): Promise<WorkingTime> {
    const em = this.dataSource.manager;
    const days = await em.find(WorkCalendarDay, { order: { weekday: 'ASC' } });
    const closures = await em.find(WorkCalendarClosure, { where: { day: MoreThanOrEqual(addDays(todayIn(this.timeZone), -1)) } });
    return new WorkingTime({
      timeZone: this.timeZone,
      days: days.map((d) => ({ weekday: d.weekday, startTime: d.startTime, endTime: d.endTime })),
      closures: closures.map((c) => String(c.day).slice(0, 10)),
    });
  }

  /**
   * Piano di tutte le macchine pianificabili: lavorazioni non concluse in ordine (prima le in corso, poi le aperte
   * per posizione) con inizio e fine previsti, tempo residuo e totale della coda in giorni lavorativi.
   */
  async plan(now = new Date()) {
    const em = this.dataSource.manager;
    const machines = await em.find(Machine, { where: { schedulable: true }, relations: { machineType: true }, order: { sortOrder: 'ASC', name: 'ASC' } });
    const rows: PlanRow[] = machines.length
      ? await em.query(
          `SELECT * FROM (
             SELECT si.id, si.machine_id, ${effectiveStatusSql()} AS eff, si.position::float AS position,
                    si.setup_seconds, si.unit_seconds, si.internal_pause_seconds, si.end_pause_seconds, si.quantity,
                    po.id AS production_order_id, po.quantity AS order_quantity, po.expected_delivery_date::text AS expected_delivery_date,
                    po.status AS order_status, d.code AS drawing_code, d.revision AS drawing_revision,
                    co.code AS customer_order_code, c.name AS customer_name,
                    p.id AS part_id, p.internal_code AS part_code, p.name AS part_name
               FROM schedule_item si
               JOIN production_order po ON po.id = si.production_order_id AND po.deleted_at IS NULL
               JOIN part p ON p.id = si.part_id
               LEFT JOIN drawing d ON d.id = po.drawing_id
               LEFT JOIN customer_order co ON co.id = po.customer_order_id
               LEFT JOIN customer c ON c.id = co.customer_id
              WHERE si.deleted_at IS NULL AND si.machine_id = ANY($1)) x
            WHERE x.eff <> 'DONE'`,
          [machines.map((m) => m.id)],
        )
      : [];

    // Tempo già lavorato dalle fasi collegate (anche quelle in corso), al netto dei fermi.
    const inProgressIds = rows.filter((r) => r.eff === 'IN_PROGRESS').map((r) => r.id);
    const phases = inProgressIds.length
      ? await em.find(WorkPhase, { where: { scheduleItemId: In(inProgressIds) }, relations: { stops: true, operator: true } })
      : [];
    const worked = new Map<number, number>();
    const firstStart = new Map<number, Date>();
    const openPhase = new Map<number, WorkPhase>();
    for (const ph of phases) {
      const sid = ph.scheduleItemId!;
      const stops = (ph.stops ?? []).filter((s) => !s.deletedAt);
      worked.set(sid, (worked.get(sid) ?? 0) + phaseWorkedSeconds({ ...ph, stops }, now));
      const prev = firstStart.get(sid);
      if (!prev || ph.setupStartedAt < prev) firstStart.set(sid, ph.setupStartedAt);
      if (ph.status === 'IN_PROGRESS') openPhase.set(sid, ph);
    }

    let wt: WorkingTime | null = null;
    let calendarError: string | null = null;
    try {
      wt = await this.workingTime();
    } catch (e) {
      if (e instanceof CalendarError) calendarError = e.message;
      else throw e;
    }

    const out = machines.map((m) => {
      const mine = rows.filter((r) => r.machine_id === m.id);
      const jobs: PlanJob[] = mine.map((r) => ({
        id: r.id, status: r.eff, position: Number(r.position), setupSeconds: r.setup_seconds, unitSeconds: r.unit_seconds,
        quantity: r.quantity, internalPauseSeconds: r.internal_pause_seconds, endPauseSeconds: r.end_pause_seconds,
        workedSeconds: worked.get(r.id) ?? 0,
      }));
      let plan: ReturnType<typeof planMachine> | null = null;
      if (wt) {
        try {
          plan = planMachine(jobs, wt, now);
        } catch (e) {
          if (e instanceof CalendarError) calendarError = e.message;
          else throw e;
        }
      }
      const ordered = plan
        ? plan.jobs.map((p) => ({ row: mine.find((r) => r.id === p.id)!, p }))
        : [...mine].sort((a, b) => (a.eff === b.eff ? a.position - b.position : a.eff === 'IN_PROGRESS' ? -1 : 1)).map((row) => ({ row, p: null }));
      const items = ordered.map(({ row: r, p }, idx) => {
        const end = p?.plannedEnd ?? null;
        const endDay = end ? formatInTimeZone(end, this.timeZone, 'yyyy-MM-dd') : null;
        const op = openPhase.get(r.id);
        return {
          id: r.id,
          rank: idx + 1,
          position: Number(r.position),
          status: r.eff,
          machineId: r.machine_id,
          setupSeconds: r.setup_seconds,
          unitSeconds: r.unit_seconds,
          internalPauseSeconds: r.internal_pause_seconds,
          endPauseSeconds: r.end_pause_seconds,
          quantity: r.quantity,
          /** Tempo totale: lavorazione × quantità + attrezzaggio + pausa interna. */
          totalSeconds: r.setup_seconds + r.unit_seconds * r.quantity + r.internal_pause_seconds,
          workedSeconds: worked.get(r.id) ?? 0,
          remainingSeconds: p?.remainingSeconds ?? null,
          startedAt: firstStart.get(r.id) ?? null,
          plannedStart: p?.plannedStart ?? null,
          plannedEnd: end,
          endsAfterDelivery: !!(endDay && r.expected_delivery_date && endDay > r.expected_delivery_date),
          currentOperator: op?.operator ? `${op.operator.firstName} ${op.operator.lastName}`.trim() : null,
          productionOrder: {
            id: r.production_order_id, quantity: r.order_quantity, expectedDeliveryDate: r.expected_delivery_date, status: r.order_status,
            drawingCode: r.drawing_code, drawingRevision: r.drawing_revision, customerOrderCode: r.customer_order_code, customerName: r.customer_name,
          },
          part: { id: r.part_id, internalCode: r.part_code, name: r.part_name },
        };
      });
      return {
        machine: { id: m.id, name: m.name, machineTypeId: m.machineTypeId, machineTypeName: m.machineType?.name ?? null },
        items,
        totalSeconds: plan?.totalSeconds ?? items.reduce((s, i) => s + Math.max(0, i.totalSeconds - i.workedSeconds) + i.endPauseSeconds, 0),
        totalWorkingDays: plan?.totalWorkingDays ?? null,
        queueEnd: plan?.queueEnd ?? null,
      };
    });
    return {
      generatedAt: now,
      averageDaySeconds: wt ? Math.round(wt.averageDaySeconds()) : null,
      calendarError,
      machines: out,
    };
  }

  /**
   * Pianificato / consuntivo (02-produzione §4.8, 03-report §5.1): per ogni macchina pianificabile le lavorazioni
   * concluse la cui prima fase collegata è iniziata nel periodo; tempi reali = somma delle fasi collegate
   * non eliminate (fermi non sottratti, come nel report originale).
   */
  async plannedVsActual(from?: string, to?: string) {
    const today = todayIn(this.timeZone);
    const fromDay = (from ?? addDays(today, -7)).slice(0, 10);
    const toDay = (to ?? today).slice(0, 10);
    const fromTs = fromZonedTime(`${fromDay}T00:00:00`, this.timeZone);
    const toTs = fromZonedTime(`${addDays(toDay, 1)}T00:00:00`, this.timeZone);
    const rows: any[] = await this.dataSource.query(
      `SELECT si.id, si.machine_id, m.name AS machine_name, si.setup_seconds, si.unit_seconds, si.quantity,
              po.id AS production_order_id, c.name AS customer_name, co.code AS customer_order_code,
              p.id AS part_id, p.internal_code AS part_code, p.name AS part_name,
              MIN(wp.setup_started_at) AS started_at,
              MAX(COALESCE(wp.work_ended_at, wp.setup_ended_at)) AS ended_at,
              COALESCE(SUM(GREATEST(0, EXTRACT(EPOCH FROM (wp.setup_ended_at - wp.setup_started_at)))), 0)::int AS actual_setup,
              COALESCE(SUM(GREATEST(0, EXTRACT(EPOCH FROM (wp.work_ended_at - wp.work_started_at)))), 0)::int AS actual_work,
              COUNT(wp.id)::int AS phase_count
         FROM schedule_item si
         JOIN machine m ON m.id = si.machine_id AND m.schedulable AND m.deleted_at IS NULL
         JOIN production_order po ON po.id = si.production_order_id
         JOIN part p ON p.id = si.part_id
         LEFT JOIN customer_order co ON co.id = po.customer_order_id
         LEFT JOIN customer c ON c.id = co.customer_id
         JOIN work_phase wp ON wp.schedule_item_id = si.id AND wp.deleted_at IS NULL
        WHERE si.deleted_at IS NULL AND ${effectiveStatusSql()} = 'DONE'
        GROUP BY si.id, m.id, po.id, c.name, co.code, p.id
       HAVING MIN(wp.setup_started_at) >= $1 AND MIN(wp.setup_started_at) < $2
        ORDER BY m.sort_order, m.name, MIN(wp.setup_started_at)`,
      [fromTs, toTs],
    );
    const machines = new Map<number, { machineId: number; machineName: string; items: any[]; totals: Record<string, number> }>();
    for (const r of rows) {
      const plannedSetup = r.setup_seconds;
      const plannedWork = r.unit_seconds * r.quantity;
      const item = {
        id: r.id,
        productionOrderId: r.production_order_id,
        customerName: r.customer_name,
        customerOrderCode: r.customer_order_code,
        part: { id: r.part_id, internalCode: r.part_code, name: r.part_name },
        quantity: r.quantity,
        startedAt: r.started_at,
        endedAt: r.ended_at,
        phaseCount: r.phase_count,
        plannedSetup,
        plannedWork,
        plannedTotal: plannedSetup + plannedWork,
        actualSetup: r.actual_setup,
        actualWork: r.actual_work,
        actualTotal: r.actual_setup + r.actual_work,
      };
      const g = machines.get(r.machine_id) ?? { machineId: r.machine_id, machineName: r.machine_name, items: [] as any[], totals: { plannedTotal: 0, actualTotal: 0 } };
      g.items.push(item);
      g.totals.plannedTotal += item.plannedTotal;
      g.totals.actualTotal += item.actualTotal;
      machines.set(r.machine_id, g);
    }
    return { from: fromDay, to: toDay, machines: [...machines.values()] };
  }
}
