import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { PhaseDataService, PhaseRow } from './phase-data.service';
import { dayBounds, drawingLabel, localTime, localWeekday, parseDay, personName, todayLocal } from './report-utils';

export type BlockKind = 'SETUP' | 'WORK' | 'STOP' | 'INSPECTION' | 'EXTRA';

export const BLOCK_LABELS: Record<BlockKind, string> = {
  SETUP: 'Attrezzaggio',
  WORK: 'Lavorazione',
  STOP: 'Fermo macchina',
  INSPECTION: 'Collaudo',
  EXTRA: 'Lavoro extra',
};

export interface DailyBlock {
  key: string;
  kind: BlockKind;
  kindLabel: string;
  /** Inizio e fine del blocco dentro il giorno (troncati ai confini del giorno). */
  start: string;
  end: string;
  seconds: number;
  /** Attività ancora aperta oggi: fine = adesso. */
  inProgress: boolean;
  /** Attività mai chiusa di un giorno passato: disegnata fino a fine orario, esclusa dai totali. */
  notClosed: boolean;
  /** Il blocco continua dal giorno prima o nel giorno dopo. */
  clipped: boolean;
  /** Solo fermi: false = pausa dell'operatore con macchina che lavora. */
  machineStopped?: boolean;
  /** Testo breve dentro il blocco. */
  caption: string;
  detail: {
    operatorId: number | null;
    operator: string;
    machineId: number | null;
    machine: string | null;
    machineType: string | null;
    productionOrderId: number | null;
    customerOrderCode: string | null;
    customer: string | null;
    drawing: string | null;
    part: string | null;
    phaseNumber: number | null;
    phaseStatus: string | null;
    startedAt: string;
    endedAt: string | null;
    goodQty: number | null;
    scrapQty: number | null;
    reason: string | null;
    isPause: boolean | null;
    extraActivity: string | null;
    notes: string | null;
    /** Solo attrezzaggio/lavorazione: tempo netto (fermi tolti) dell'intervallo. */
    netSeconds: number | null;
  };
}

export interface DailyRow {
  id: number;
  label: string;
  sublabel: string | null;
  firstLogin: string | null;
  blocks: DailyBlock[];
  totals: Record<BlockKind, number>;
}

const emptyKindTotals = (): Record<BlockKind, number> => ({ SETUP: 0, WORK: 0, STOP: 0, INSPECTION: 0, EXTRA: 0 });

/**
 * Riassunto giornaliero (03-report §2): blocchi di attività per operatore o per macchina.
 * - Solo operatori dei reparti con is_production.
 * - Attività chiuse: mostrate se si sovrappongono al giorno (troncate ai confini).
 * - Attività aperte: solo nel giorno in cui iniziano; oggi finiscono "adesso" (in corso), nei giorni
 *   passati fino a fine orario di lavoro, marcate "mai chiusa" e non contate nei totali. Vale per tutte
 *   le attività, anche collaudi, lavori extra e fermi.
 */
@Injectable()
export class DailyService {
  constructor(
    private readonly ds: DataSource,
    private readonly phases: PhaseDataService,
  ) {}

  async build(mode: 'operators' | 'machines', dayParam?: string, nowParam?: Date) {
    const now = nowParam ?? new Date();
    const day = parseDay(dayParam, todayLocal(now));
    const { start, end } = dayBounds(day);
    const isToday = day === todayLocal(now);

    const prodFilter = `o.department_id IN (SELECT id FROM department WHERE is_production AND deleted_at IS NULL)`;
    const phases = await this.phases.load(
      `${prodFilter} AND wp.setup_started_at < $2
        AND (wp.setup_started_at >= $1 OR wp.setup_ended_at >= $1 OR wp.work_ended_at >= $1 OR wp.work_started_at >= $1)`,
      [start, end],
    );
    const inspections: any[] = await this.ds.query(
      `SELECT i.id, i.production_order_id, i.operator_id, o.first_name, o.last_name, i.machine_id, m.name AS machine_name,
              i.started_at, i.ended_at, i.good_qty, i.scrap_qty, i.notes,
              d.code AS drawing_code, d.revision AS drawing_revision, co.code AS customer_order_code, c.name AS customer_name
         FROM inspection i
         JOIN operator o ON o.id = i.operator_id
         JOIN production_order po ON po.id = i.production_order_id
         JOIN drawing d ON d.id = po.drawing_id
         JOIN customer_order co ON co.id = po.customer_order_id
         JOIN customer c ON c.id = co.customer_id
         LEFT JOIN machine m ON m.id = i.machine_id
        WHERE i.deleted_at IS NULL AND ${prodFilter} AND i.started_at < $2 AND (i.started_at >= $1 OR i.ended_at >= $1)`,
      [start, end],
    );
    const extras: any[] =
      mode === 'operators'
        ? await this.ds.query(
            `SELECT x.id, x.operator_id, o.first_name, o.last_name, x.machine_id, m.name AS machine_name, ea.name AS activity, x.started_at, x.ended_at
               FROM extra_activity_log x
               JOIN operator o ON o.id = x.operator_id
               JOIN extra_activity ea ON ea.id = x.extra_activity_id
               LEFT JOIN machine m ON m.id = x.machine_id
              WHERE x.deleted_at IS NULL AND ${prodFilter} AND x.started_at < $2 AND (x.started_at >= $1 OR x.ended_at >= $1)`,
            [start, end],
          )
        : [];

    const weekday = localWeekday(day);
    const [cal] = await this.ds.query(`SELECT start_time, end_time FROM work_calendar_day WHERE weekday = $1`, [weekday]);
    const [closure] = await this.ds.query(`SELECT reason FROM work_calendar_closure WHERE day = $1 LIMIT 1`, [day]);
    const calendar = cal?.start_time && cal?.end_time && !closure ? { start: localTime(day, cal.start_time).toISOString(), end: localTime(day, cal.end_time).toISOString() } : null;
    const calendarEnd = calendar ? new Date(calendar.end).getTime() : null;

    /**
     * Normalizza un intervallo nel giorno; null se non va mostrato.
     * Attività mai chiuse di un giorno passato: disegnate fino a fine orario (almeno 15 minuti) e non
     * contate nei totali.
     */
    const clip = (s: Date, e: Date | null) => {
      const sMs = new Date(s).getTime();
      let eMs: number;
      let inProgress = false;
      let notClosed = false;
      if (!e) {
        if (sMs < start.getTime()) return null; // aperte: solo nel giorno di inizio
        if (isToday) { eMs = Math.min(now.getTime(), end.getTime()); inProgress = true; }
        else { eMs = Math.max(sMs + 15 * 60_000, calendarEnd ?? 0); notClosed = true; }
      } else {
        eMs = new Date(e).getTime();
        if (eMs < sMs) return null; // orari incoerenti
      }
      const cs = Math.max(sMs, start.getTime());
      const ce = Math.min(eMs, end.getTime());
      if (ce < cs || (ce === cs && !inProgress)) return null;
      return { start: new Date(cs).toISOString(), end: new Date(ce).toISOString(), seconds: Math.round((ce - cs) / 1000), inProgress, notClosed, clipped: cs !== sMs || (!!e && ce !== eMs) };
    };

    type Entry = { block: DailyBlock; operatorId: number; operatorFirst: string; operatorLast: string; machineId: number | null; machineName: string | null };
    const entries: Entry[] = [];
    const initials = (f: string, l: string) => `${f ? `${f[0]}. ` : ''}${l}`;

    const phaseDetail = (p: PhaseRow, startedAt: Date, endedAt: Date | null, netSeconds: number | null) => ({
      operatorId: p.operatorId,
      operator: personName(p.operatorFirstName, p.operatorLastName),
      machineId: p.machineId,
      machine: p.machineName,
      machineType: p.machineTypeName,
      productionOrderId: p.productionOrderId,
      customerOrderCode: p.customerOrderCode,
      customer: p.customerName,
      drawing: drawingLabel(p.drawingCode, p.drawingRevision),
      part: p.partCode,
      phaseNumber: p.phaseNumber,
      phaseStatus: p.status,
      startedAt: new Date(startedAt).toISOString(),
      endedAt: endedAt ? new Date(endedAt).toISOString() : null,
      goodQty: p.goodQty,
      scrapQty: p.scrapQty,
      reason: null,
      isPause: null,
      extraActivity: null,
      notes: null,
      netSeconds,
    });

    for (const p of phases) {
      const who = { operatorId: p.operatorId, operatorFirst: p.operatorFirstName, operatorLast: p.operatorLastName, machineId: p.machineId, machineName: p.machineName };
      const caption = mode === 'machines' ? initials(p.operatorFirstName, p.operatorLastName) : `${p.productionOrderId} · ${p.machineName}`;
      // Un attrezzaggio senza fine ma con lavorazione iniziata si chiude all'inizio della lavorazione.
      const setupEnd = p.setupEndedAt ?? p.workStartedAt ?? null;
      const s = clip(p.setupStartedAt, setupEnd);
      if (s) entries.push({ ...who, block: { key: `SETUP-${p.id}`, kind: 'SETUP', kindLabel: BLOCK_LABELS.SETUP, ...s, caption, detail: phaseDetail(p, p.setupStartedAt, setupEnd, p.setupEndedAt ? p.times.setupNet : null) } });
      if (p.workStartedAt) {
        const w = clip(p.workStartedAt, p.workEndedAt);
        if (w) entries.push({ ...who, block: { key: `WORK-${p.id}`, kind: 'WORK', kindLabel: BLOCK_LABELS.WORK, ...w, caption, detail: phaseDetail(p, p.workStartedAt, p.workEndedAt, p.workEndedAt ? p.times.workNet : null) } });
      }
      for (const st of p.stops) {
        const c = clip(st.startedAt, st.endedAt);
        if (!c) continue;
        entries.push({
          ...who,
          block: {
            key: `STOP-${st.id}`, kind: 'STOP', kindLabel: st.isPause ? 'Pausa' : BLOCK_LABELS.STOP, ...c, machineStopped: st.machineStopped,
            caption: st.reasonName ?? 'Fermo',
            detail: { ...phaseDetail(p, st.startedAt, st.endedAt, null), reason: st.reasonName ?? 'Non dichiarata', isPause: st.isPause, goodQty: null, scrapQty: null },
          },
        });
      }
    }

    let inspectionMachine: { id: number; name: string } | null = null;
    if (mode === 'machines' && inspections.some((i) => !i.machine_id)) {
      const [m] = await this.ds.query(
        `SELECT m.id, m.name FROM machine m JOIN machine_type mt ON mt.id = m.machine_type_id
          WHERE mt.is_inspection AND m.deleted_at IS NULL ORDER BY m.sort_order, m.id LIMIT 1`,
      );
      inspectionMachine = m ?? { id: 0, name: 'Collaudo' };
    }
    for (const i of inspections) {
      const c = clip(i.started_at, i.ended_at);
      if (!c) continue;
      const machineId = i.machine_id ?? inspectionMachine?.id ?? null;
      const machineName = i.machine_name ?? inspectionMachine?.name ?? null;
      entries.push({
        operatorId: i.operator_id, operatorFirst: i.first_name, operatorLast: i.last_name, machineId, machineName,
        block: {
          key: `INSPECTION-${i.id}`, kind: 'INSPECTION', kindLabel: BLOCK_LABELS.INSPECTION, ...c,
          caption: mode === 'machines' ? initials(i.first_name, i.last_name) : `Collaudo ${i.production_order_id}`,
          detail: {
            operatorId: i.operator_id, operator: personName(i.first_name, i.last_name), machineId, machine: machineName, machineType: null,
            productionOrderId: i.production_order_id, customerOrderCode: i.customer_order_code, customer: i.customer_name,
            drawing: drawingLabel(i.drawing_code, i.drawing_revision), part: null, phaseNumber: null, phaseStatus: null,
            startedAt: new Date(i.started_at).toISOString(), endedAt: i.ended_at ? new Date(i.ended_at).toISOString() : null,
            goodQty: i.good_qty, scrapQty: i.scrap_qty, reason: null, isPause: null, extraActivity: null, notes: i.notes, netSeconds: null,
          },
        },
      });
    }
    for (const x of extras) {
      const c = clip(x.started_at, x.ended_at);
      if (!c) continue;
      entries.push({
        operatorId: x.operator_id, operatorFirst: x.first_name, operatorLast: x.last_name, machineId: x.machine_id, machineName: x.machine_name,
        block: {
          key: `EXTRA-${x.id}`, kind: 'EXTRA', kindLabel: BLOCK_LABELS.EXTRA, ...c, caption: x.activity,
          detail: {
            operatorId: x.operator_id, operator: personName(x.first_name, x.last_name), machineId: x.machine_id, machine: x.machine_name, machineType: null,
            productionOrderId: null, customerOrderCode: null, customer: null, drawing: null, part: null, phaseNumber: null, phaseStatus: null,
            startedAt: new Date(x.started_at).toISOString(), endedAt: x.ended_at ? new Date(x.ended_at).toISOString() : null,
            goodQty: null, scrapQty: null, reason: null, isPause: null, extraActivity: x.activity, notes: null, netSeconds: null,
          },
        },
      });
    }

    // Primo accesso al tablet del giorno per operatore.
    const logins: { operator_id: number; first_login: Date }[] = await this.ds.query(
      `SELECT s.operator_id, min(s.started_at) AS first_login FROM operator_session s
        WHERE s.started_at >= $1 AND s.started_at < $2 GROUP BY s.operator_id`,
      [start, end],
    );
    const loginByOp = new Map(logins.map((l) => [l.operator_id, new Date(l.first_login).toISOString()]));

    const rowsMap = new Map<number, DailyRow & { sort: string }>();
    if (mode === 'operators') {
      for (const e of entries) {
        let row = rowsMap.get(e.operatorId);
        if (!row) {
          row = { id: e.operatorId, label: personName(e.operatorFirst, e.operatorLast), sublabel: null, firstLogin: loginByOp.get(e.operatorId) ?? null, blocks: [], totals: emptyKindTotals(), sort: `${e.operatorLast} ${e.operatorFirst}`.toLowerCase() };
          rowsMap.set(e.operatorId, row);
        }
        row.blocks.push(e.block);
      }
    } else {
      const machineInfo: { id: number; sort_order: number; type_name: string }[] = await this.ds.query(
        `SELECT m.id, m.sort_order, mt.name AS type_name FROM machine m JOIN machine_type mt ON mt.id = m.machine_type_id WHERE m.id = ANY($1)`,
        [[...new Set(entries.map((e) => e.machineId).filter((v): v is number => !!v))]],
      );
      const info = new Map(machineInfo.map((m) => [m.id, m]));
      for (const e of entries) {
        const id = e.machineId ?? 0;
        let row = rowsMap.get(id);
        if (!row) {
          const mi = info.get(id);
          row = { id, label: e.machineName ?? 'Senza postazione', sublabel: mi?.type_name ?? null, firstLogin: null, blocks: [], totals: emptyKindTotals(), sort: `${String(mi?.sort_order ?? 9999).padStart(6, '0')} ${(e.machineName ?? '').toLowerCase()}` };
          rowsMap.set(id, row);
        }
        row.blocks.push(e.block);
      }
    }

    // Ordine di disegno: prima lavorazione, poi attrezzaggio, extra, collaudo, fermi (in alto).
    const layer: Record<BlockKind, number> = { WORK: 1, SETUP: 2, EXTRA: 3, INSPECTION: 4, STOP: 5 };
    const rows = [...rowsMap.values()].sort((a, b) => a.sort.localeCompare(b.sort)).map(({ sort: _s, ...r }) => {
      r.blocks.sort((a, b) => layer[a.kind] - layer[b.kind] || a.start.localeCompare(b.start));
      for (const b of r.blocks) if (!b.notClosed) r.totals[b.kind] += b.seconds;
      return r;
    });

    // Asse dei tempi: dal primo accesso o prima attività (arrotondato all'ora) all'ultima fine.
    // Le attività mai chiuse o a cavallo della mezzanotte non allargano l'asse (vengono tagliate).
    const core = rows.flatMap((r) => r.blocks.filter((b) => !b.notClosed && !b.clipped));
    const starts = [...core.map((b) => b.start), ...rows.map((r) => r.firstLogin).filter((v): v is string => !!v)].map((v) => new Date(v).getTime());
    const ends = core.map((b) => new Date(b.end).getTime());
    if (calendar) { starts.push(new Date(calendar.start).getTime()); ends.push(new Date(calendar.end).getTime()); }
    const hour = 3600_000;
    const floorHour = (v: number) => start.getTime() + Math.floor((v - start.getTime()) / hour) * hour;
    const ceilHour = (v: number) => start.getTime() + Math.ceil((v - start.getTime()) / hour) * hour;
    const axisStart = starts.length ? Math.max(start.getTime(), floorHour(Math.min(...starts))) : localTime(day, '06:00').getTime();
    const axisEnd = ends.length ? Math.min(end.getTime(), Math.max(ceilHour(Math.max(...ends)), axisStart + hour)) : localTime(day, '18:00').getTime();

    return {
      day,
      mode,
      isToday,
      axisStart: new Date(axisStart).toISOString(),
      axisEnd: new Date(axisEnd).toISOString(),
      calendar,
      closure: closure?.reason ?? (closure ? 'Chiusura' : null),
      generatedAt: now.toISOString(),
      rows,
    };
  }
}
