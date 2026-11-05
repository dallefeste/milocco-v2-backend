/**
 * Regola unica dei tempi netti, usata da tutti i report (stampa tempi ordine, report operatore,
 * ordine cliente, tempi previsti, riepiloghi giornalieri, cruscotto).
 *
 * Definizioni (durate in secondi interi):
 * - attrezzaggio lordo  = fine attrezzaggio − inizio attrezzaggio;
 * - lavorazione lorda   = fine lavorazione − inizio lavorazione;
 * - attrezzaggio netto  = lordo − parte dei fermi (di qualunque tipo) che cade dentro l'attrezzaggio;
 * - lavorazione netta   = lorda − parte dei fermi con macchina ferma che cade dentro la lavorazione
 *                         (le pause dell'operatore con macchina che lavora non si tolgono);
 * - tempo intermedio    = inizio lavorazione − fine attrezzaggio (può essere negativo se le due fasi
 *                         si sovrappongono: il segno si conserva);
 * - tempo totale        = attrezzaggio netto + lavorazione netta (sempre coerente con le due colonne);
 * - tempo complessivo   = attrezzaggio netto + intermedio + lavorazione netta;
 * - tempo pausa         = somma dei fermi con causale di tipo "pausa";
 * - tempo fermo macchina= somma dei fermi con macchina ferma;
 * - tempo medio unitario= lavorazione netta / pezzi (buoni + scarti; se zero, quantità prevista).
 *
 * Casi limite:
 * - si sottrae solo la parte del fermo che si sovrappone all'intervallo (un fermo a cavallo tra
 *   attrezzaggio e lavorazione viene diviso); fermi sovrapposti tra loro si contano una volta sola;
 * - intervallo senza fine (fase aperta): se viene passato `openUntil` (es. "adesso" per le viste in
 *   tempo reale) l'intervallo è troncato a quell'istante e marcato `open`; altrimenti vale 0 e la
 *   fase è marcata `open` (i report consuntivi non contano tempi non chiusi);
 * - fine prima dell'inizio: intervallo ignorato (0) e fase marcata `invalid`;
 * - fermo senza fine: troncato a `openUntil` se passato e la fase è aperta, altrimenti ignorato;
 * - nessun valore netto è mai negativo.
 */

export interface StopInput {
  startedAt: Date | string;
  endedAt: Date | string | null;
  machineStopped: boolean;
  /** true se la causale è di tipo pausa (pranzo, caffè, fine giornata). */
  isPause?: boolean;
}

export interface PhaseInput {
  setupStartedAt: Date | string | null;
  setupEndedAt: Date | string | null;
  workStartedAt: Date | string | null;
  workEndedAt: Date | string | null;
  goodQty?: number | null;
  scrapQty?: number | null;
  stops?: StopInput[];
}

export interface PhaseTimes {
  setupGross: number;
  workGross: number;
  setupNet: number;
  workNet: number;
  /** Tempo morto tra fine attrezzaggio e inizio lavorazione (può essere negativo). */
  intermediate: number;
  /** setupNet + workNet */
  total: number;
  /** setupNet + intermediate + workNet */
  overall: number;
  /** Fermi tolti dall'attrezzaggio. */
  setupStops: number;
  /** Fermi (macchina ferma) tolti dalla lavorazione. */
  workStops: number;
  /** Somma dei fermi con macchina ferma. */
  machineStopSeconds: number;
  /** Somma dei fermi con causale "pausa". */
  pauseSeconds: number;
  /** Somma di tutti i fermi chiusi. */
  stopSeconds: number;
  stopCount: number;
  /** Tempo per pezzo (lavorazione netta / pezzi) o null se non calcolabile. */
  avgUnitSeconds: number | null;
  /** Almeno un intervallo non è chiuso. */
  open: boolean;
  /** Almeno un intervallo ha fine prima dell'inizio. */
  invalid: boolean;
}

type Interval = [number, number];

const ms = (v: Date | string | null | undefined): number | null => {
  if (v === null || v === undefined) return null;
  const t = v instanceof Date ? v.getTime() : new Date(v).getTime();
  return Number.isNaN(t) ? null : t;
};

/** Secondi interi tra due istanti in millisecondi. */
const sec = (a: number, b: number) => Math.round((b - a) / 1000);

/**
 * Intervallo [inizio, fine] normalizzato: null se non utilizzabile.
 * Restituisce anche i flag open/invalid.
 */
export function resolveInterval(
  start: Date | string | null | undefined,
  end: Date | string | null | undefined,
  openUntil?: Date | null,
): { interval: Interval | null; open: boolean; invalid: boolean } {
  const s = ms(start);
  if (s === null) return { interval: null, open: false, invalid: false };
  let e = ms(end);
  let open = false;
  if (e === null) {
    open = true;
    const until = ms(openUntil ?? null);
    if (until === null || until <= s) return { interval: null, open, invalid: false };
    e = until;
  }
  if (e < s) return { interval: null, open, invalid: true };
  return { interval: [s, e], open, invalid: false };
}

/** Unisce intervalli sovrapposti (ordinati per inizio). */
export function mergeIntervals(list: Interval[]): Interval[] {
  const sorted = list.filter((i) => i[1] > i[0]).sort((a, b) => a[0] - b[0]);
  const out: Interval[] = [];
  for (const cur of sorted) {
    const last = out[out.length - 1];
    if (last && cur[0] <= last[1]) last[1] = Math.max(last[1], cur[1]);
    else out.push([cur[0], cur[1]]);
  }
  return out;
}

/** Secondi di sovrapposizione tra un intervallo e un insieme di intervalli già uniti. */
export function overlapSeconds(target: Interval | null, merged: Interval[]): number {
  if (!target) return 0;
  let total = 0;
  for (const [a, b] of merged) {
    const s = Math.max(a, target[0]);
    const e = Math.min(b, target[1]);
    if (e > s) total += e - s;
  }
  return Math.round(total / 1000);
}

/**
 * Calcola i tempi di una fase secondo la regola unica.
 * @param openUntil istante a cui troncare gli intervalli aperti (es. adesso); se assente valgono 0.
 * @param plannedQty quantità prevista, usata per il tempo medio se la fase non ha pezzi registrati.
 */
export function computePhaseTimes(phase: PhaseInput, opts: { openUntil?: Date | null; plannedQty?: number | null } = {}): PhaseTimes {
  const setup = resolveInterval(phase.setupStartedAt, phase.setupEndedAt, opts.openUntil);
  // La lavorazione non ancora iniziata non è "aperta".
  const work = phase.workStartedAt ? resolveInterval(phase.workStartedAt, phase.workEndedAt, opts.openUntil) : { interval: null, open: false, invalid: false };
  const phaseOpen = setup.open || work.open;

  const all: Interval[] = [];
  const machine: Interval[] = [];
  let pauseSeconds = 0;
  let machineStopSeconds = 0;
  let stopSeconds = 0;
  let stopCount = 0;
  for (const st of phase.stops ?? []) {
    stopCount++;
    const r = resolveInterval(st.startedAt, st.endedAt, phaseOpen ? opts.openUntil : null);
    if (!r.interval) continue;
    const d = sec(r.interval[0], r.interval[1]);
    stopSeconds += d;
    if (st.isPause) pauseSeconds += d;
    all.push(r.interval);
    if (st.machineStopped) {
      machine.push(r.interval);
      machineStopSeconds += d;
    }
  }
  const allMerged = mergeIntervals(all);
  const machineMerged = mergeIntervals(machine);

  const setupGross = setup.interval ? sec(setup.interval[0], setup.interval[1]) : 0;
  const workGross = work.interval ? sec(work.interval[0], work.interval[1]) : 0;
  const setupStops = Math.min(setupGross, overlapSeconds(setup.interval, allMerged));
  const workStops = Math.min(workGross, overlapSeconds(work.interval, machineMerged));
  const setupNet = Math.max(0, setupGross - setupStops);
  const workNet = Math.max(0, workGross - workStops);

  const se = ms(phase.setupEndedAt);
  const ws = ms(phase.workStartedAt);
  const intermediate = se !== null && ws !== null && !setup.invalid ? sec(se, ws) : 0;

  const pieces = (phase.goodQty ?? 0) + (phase.scrapQty ?? 0);
  const divisor = pieces > 0 ? pieces : opts.plannedQty && opts.plannedQty > 0 ? opts.plannedQty : 0;
  const avgUnitSeconds = workNet > 0 && divisor > 0 ? Math.round((workNet / divisor) * 10) / 10 : null;

  return {
    setupGross,
    workGross,
    setupNet,
    workNet,
    intermediate,
    total: setupNet + workNet,
    overall: setupNet + intermediate + workNet,
    setupStops,
    workStops,
    machineStopSeconds,
    pauseSeconds,
    stopSeconds,
    stopCount,
    avgUnitSeconds,
    open: phaseOpen,
    invalid: setup.invalid || work.invalid,
  };
}

/** Totali di più fasi. */
export interface TimeTotals {
  setupNet: number;
  workNet: number;
  intermediate: number;
  total: number;
  overall: number;
  machineStopSeconds: number;
  pauseSeconds: number;
  phases: number;
}

export const emptyTotals = (): TimeTotals => ({ setupNet: 0, workNet: 0, intermediate: 0, total: 0, overall: 0, machineStopSeconds: 0, pauseSeconds: 0, phases: 0 });

export function addTimes(acc: TimeTotals, t: PhaseTimes): TimeTotals {
  acc.setupNet += t.setupNet;
  acc.workNet += t.workNet;
  acc.intermediate += t.intermediate;
  acc.total += t.total;
  acc.overall += t.overall;
  acc.machineStopSeconds += t.machineStopSeconds;
  acc.pauseSeconds += t.pauseSeconds;
  acc.phases += 1;
  return acc;
}

/** Percentuale con 2 decimali (es. 12.34), 0 se il totale è zero. */
export const percent = (part: number, total: number): number => (total > 0 ? Math.round((part / total) * 10000) / 100 : 0);

/** Arrotondamento al centesimo (importi). */
export const round2 = (v: number): number => Math.round((v + Number.EPSILON) * 100) / 100;

/** Costo di un tempo in secondi a una tariffa oraria. */
export const costOf = (seconds: number, hourlyRate: number): number => (seconds / 3600) * (hourlyRate || 0);

/**
 * Durata per le stampe: "H:MM:SS" senza limite di 24 ore e con il segno per i negativi
 * (corregge la stampa "modulo 24 ore" del sistema precedente).
 */
export function formatHms(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return '';
  const neg = seconds < 0;
  const t = Math.abs(Math.round(seconds));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return `${neg ? '-' : ''}${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
