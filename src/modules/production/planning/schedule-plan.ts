/**
 * Calcolo di inizio e fine previsti delle lavorazioni in coda su una macchina (funzioni pure, senza database).
 *
 * Regole (docs/analisi/02-produzione.md §4.5–4.6, corrette come da docs/architettura.md):
 * - ordine di calcolo: prima le lavorazioni in corso, poi le aperte, ciascun gruppo per posizione;
 * - si parte da "adesso", mai prima dell'apertura della giornata lavorativa;
 * - tempo richiesto = attrezzaggio + lavorazione per pezzo × quantità + pausa interna;
 * - tempo residuo = richiesto − tempo già lavorato da TUTTE le fasi collegate (comprese quelle in corso),
 *   mai negativo: una lavorazione in corso finisce quindi "adesso + residuo", mai nel passato;
 * - le lavorazioni si susseguono senza sovrapporsi (anche due "in corso" sulla stessa macchina);
 * - la pausa di fine lavorazione si consuma dentro l'orario di lavoro;
 * - si saltano i giorni senza orario e le chiusure straordinarie; un solo turno continuo al giorno.
 */
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';

export interface CalendarDay {
  /** 0 = lunedì … 6 = domenica */
  weekday: number;
  /** 'HH:MM' o 'HH:MM:SS'; null = giorno di chiusura */
  startTime: string | null;
  endTime: string | null;
}

export interface WorkCalendar {
  days: CalendarDay[];
  /** Chiusure straordinarie (ferie, festività) come 'YYYY-MM-DD'. */
  closures: string[];
  /** Fuso orario dell'officina, es. 'Europe/Rome'. */
  timeZone: string;
}

export interface PlanJob {
  id: number;
  status: 'OPEN' | 'IN_PROGRESS';
  position: number;
  setupSeconds: number;
  unitSeconds: number;
  quantity: number;
  internalPauseSeconds: number;
  endPauseSeconds: number;
  /** Tempo già lavorato dalle fasi collegate (vedi phaseWorkedSeconds). */
  workedSeconds: number;
}

export interface PlannedJob {
  id: number;
  plannedStart: Date;
  plannedEnd: Date;
  requiredSeconds: number;
  remainingSeconds: number;
}

export interface MachinePlan {
  jobs: PlannedJob[];
  /** Somma dei tempi residui e delle pause di fine lavorazione. */
  totalSeconds: number;
  /** totalSeconds espresso in giornate lavorative medie dell'orario reale. */
  totalWorkingDays: number;
  /** Fine prevista dell'ultima lavorazione (null se coda vuota). */
  queueEnd: Date | null;
}

export class CalendarError extends Error {}

const MAX_DAYS_AHEAD = 3700;

const toSec = (hhmm: string): number => {
  const [h = '0', m = '0', s = '0'] = hhmm.split(':');
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
};

/** 'YYYY-MM-DD' + n giorni (aritmetica di calendario, indipendente dal fuso). */
export const addDays = (day: string, n: number): string => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** Giorno della settimana con 0 = lunedì. */
export const weekdayOf = (day: string): number => (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7;

/** Orario di lavoro effettivo del calendario, con controlli di coerenza. */
export class WorkingTime {
  private readonly byWeekday = new Map<number, { start: number; end: number }>();
  private readonly closures: Set<string>;

  constructor(private readonly cal: WorkCalendar) {
    for (const d of cal.days) {
      if (!d.startTime || !d.endTime) continue;
      const start = toSec(d.startTime);
      const end = toSec(d.endTime);
      if (end > start) this.byWeekday.set(d.weekday, { start, end });
    }
    if (this.byWeekday.size === 0) {
      throw new CalendarError("Nessun giorno lavorativo nell'orario di lavoro: impostare l'orario in Anagrafiche → Orario di lavoro.");
    }
    this.closures = new Set(cal.closures);
  }

  /** Durata media di una giornata lavorativa (secondi). */
  averageDaySeconds(): number {
    const spans = [...this.byWeekday.values()].map((w) => w.end - w.start);
    return spans.reduce((a, b) => a + b, 0) / spans.length;
  }

  localDay(t: Date): string {
    return formatInTimeZone(t, this.cal.timeZone, 'yyyy-MM-dd');
  }

  private at(day: string, seconds: number): Date {
    const h = String(Math.floor(seconds / 3600)).padStart(2, '0');
    const m = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0');
    const s = String(seconds % 60).padStart(2, '0');
    return fromZonedTime(`${day}T${h}:${m}:${s}`, this.cal.timeZone);
  }

  /** Apertura e chiusura del giorno, o null se è chiuso. */
  window(day: string): { open: Date; close: Date } | null {
    if (this.closures.has(day)) return null;
    const w = this.byWeekday.get(weekdayOf(day));
    if (!w) return null;
    return { open: this.at(day, w.start), close: this.at(day, w.end) };
  }

  /** Primo istante lavorativo a partire da t (t stesso se è dentro l'orario). */
  nextWorkingInstant(t: Date): Date {
    let day = this.localDay(t);
    for (let i = 0; i < MAX_DAYS_AHEAD; i++, day = addDays(day, 1)) {
      const w = this.window(day);
      if (!w || t.getTime() >= w.close.getTime()) continue;
      return t.getTime() < w.open.getTime() ? w.open : t;
    }
    throw new CalendarError('Nessun giorno lavorativo nei prossimi anni: controllare orario e chiusure.');
  }

  /** Aggiunge `seconds` di tempo lavorativo a partire da `start`. */
  addWorkingTime(start: Date, seconds: number): Date {
    let t = this.nextWorkingInstant(start);
    let rest = Math.max(0, Math.round(seconds));
    for (let i = 0; i < MAX_DAYS_AHEAD; i++) {
      const w = this.window(this.localDay(t))!;
      const available = (w.close.getTime() - t.getTime()) / 1000;
      if (rest <= available) return new Date(t.getTime() + rest * 1000);
      rest -= available;
      t = this.nextWorkingInstant(w.close);
    }
    throw new CalendarError('Durata troppo lunga da pianificare: controllare i tempi della lavorazione.');
  }
}

/** Tempo richiesto da una lavorazione (secondi). */
export const requiredSeconds = (j: Pick<PlanJob, 'setupSeconds' | 'unitSeconds' | 'quantity' | 'internalPauseSeconds'>): number =>
  Math.max(0, j.setupSeconds || 0) + Math.max(0, j.unitSeconds || 0) * Math.max(0, j.quantity || 0) + Math.max(0, j.internalPauseSeconds || 0);

/**
 * Pianifica la coda di una macchina. `now` = istante di calcolo.
 * Le lavorazioni in corso precedono le aperte; dentro ogni gruppo vale la posizione.
 */
export function planMachine(jobs: PlanJob[], calendar: WorkCalendar | WorkingTime, now: Date): MachinePlan {
  const wt = calendar instanceof WorkingTime ? calendar : new WorkingTime(calendar);
  const ordered = [...jobs].sort((a, b) => {
    const sa = a.status === 'IN_PROGRESS' ? 0 : 1;
    const sb = b.status === 'IN_PROGRESS' ? 0 : 1;
    return sa - sb || a.position - b.position || a.id - b.id;
  });
  const out: PlannedJob[] = [];
  let cursor = now;
  let total = 0;
  for (const job of ordered) {
    const required = requiredSeconds(job);
    const remaining = Math.max(0, required - Math.max(0, job.workedSeconds || 0));
    const start = wt.nextWorkingInstant(cursor);
    const end = wt.addWorkingTime(start, remaining);
    out.push({ id: job.id, plannedStart: start, plannedEnd: end, requiredSeconds: required, remainingSeconds: remaining });
    const endPause = Math.max(0, job.endPauseSeconds || 0);
    cursor = endPause > 0 ? wt.addWorkingTime(end, endPause) : end;
    total += remaining + endPause;
  }
  return {
    jobs: out,
    totalSeconds: total,
    totalWorkingDays: Math.round((total / wt.averageDaySeconds()) * 100) / 100,
    queueEnd: out.length ? out[out.length - 1].plannedEnd : null,
  };
}

// ---------------------------------------------------------------------------
// Tempo già lavorato da una fase registrata in reparto
// ---------------------------------------------------------------------------

export interface WorkedStop {
  startedAt: Date | string;
  endedAt: Date | string | null;
  machineStopped: boolean;
}

export interface WorkedPhase {
  setupStartedAt: Date | string;
  setupEndedAt: Date | string | null;
  workStartedAt: Date | string | null;
  workEndedAt: Date | string | null;
  stops?: WorkedStop[];
}

const ms = (v: Date | string | null | undefined): number | null => (v == null ? null : new Date(v).getTime());

/** Lunghezza dell'unione degli intervalli [a,b] intersecati con [from,to]. */
function overlap(intervals: [number, number][], from: number, to: number): number {
  const clipped = intervals
    .map(([a, b]) => [Math.max(a, from), Math.min(b, to)] as [number, number])
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  let total = 0;
  let curA = -Infinity;
  let curB = -Infinity;
  for (const [a, b] of clipped) {
    if (a > curB) {
      if (curB > curA) total += curB - curA;
      curA = a;
      curB = b;
    } else curB = Math.max(curB, b);
  }
  if (curB > curA) total += curB - curA;
  return total;
}

/**
 * Tempo netto già lavorato da una fase (secondi), anche se è ancora aperta (intervalli aperti chiusi a `now`):
 * attrezzaggio meno tutti i fermi che vi cadono dentro, lavorazione meno i fermi con macchina ferma.
 */
export function phaseWorkedSeconds(p: WorkedPhase, now: Date): number {
  const nowMs = now.getTime();
  const stops = (p.stops ?? []).map((s) => ({ a: ms(s.startedAt)!, b: ms(s.endedAt) ?? nowMs, machine: s.machineStopped }));
  let total = 0;
  const setupA = ms(p.setupStartedAt);
  if (setupA != null) {
    const setupB = ms(p.setupEndedAt) ?? ms(p.workStartedAt) ?? nowMs;
    if (setupB > setupA) total += setupB - setupA - overlap(stops.map((s) => [s.a, s.b]), setupA, setupB);
  }
  const workA = ms(p.workStartedAt);
  if (workA != null) {
    const workB = ms(p.workEndedAt) ?? nowMs;
    if (workB > workA) total += workB - workA - overlap(stops.filter((s) => s.machine).map((s) => [s.a, s.b]), workA, workB);
  }
  return Math.max(0, Math.round(total / 1000));
}
