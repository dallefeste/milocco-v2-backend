import { fromZonedTime } from 'date-fns-tz';
import { CalendarError, PlanJob, WorkCalendar, phaseWorkedSeconds, planMachine } from './schedule-plan';

const TZ = 'Europe/Rome';
/** Ora locale dell'officina → istante. */
const at = (local: string) => fromZonedTime(local, TZ);
const min = (m: number) => m * 60;

/** Lun–ven 08:00–16:30, sabato e domenica chiusi (dati reali). */
const calendar = (closures: string[] = []): WorkCalendar => ({
  timeZone: TZ,
  closures,
  days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
    weekday,
    startTime: weekday < 5 ? '08:00:00' : null,
    endTime: weekday < 5 ? '16:30:00' : null,
  })),
});

const job = (p: Partial<PlanJob> & { id: number }): PlanJob => ({
  status: 'OPEN', position: p.id, setupSeconds: 0, unitSeconds: 0, quantity: 0, internalPauseSeconds: 0, endPauseSeconds: 0, workedSeconds: 0, ...p,
});

// Esempio di §4.7 adattato alle correzioni. Adesso: mercoledì 4/11/2026 ore 14:00.
const NOW = at('2026-11-04T14:00:00');
const phases = [
  // fase sospesa: attrezzaggio 10:00–10:30, lavorazione 10:30–12:00 → 2 h
  { setupStartedAt: at('2026-11-04T10:00:00'), setupEndedAt: at('2026-11-04T10:30:00'), workStartedAt: at('2026-11-04T10:30:00'), workEndedAt: at('2026-11-04T12:00:00') },
  // fase in corso dalle 13:00 (attrezzaggio 13:00–13:20, poi lavorazione): conta fino ad adesso → 1 h
  { setupStartedAt: at('2026-11-04T13:00:00'), setupEndedAt: at('2026-11-04T13:20:00'), workStartedAt: at('2026-11-04T13:20:00'), workEndedAt: null },
];
const worked = phases.reduce((s, p) => s + phaseWorkedSeconds(p, NOW), 0);
const exampleJobs = (): PlanJob[] => [
  // B e C aperte; A in corso ma con posizione più alta: va comunque per prima
  job({ id: 2, position: 1, quantity: 30, setupSeconds: min(60), unitSeconds: min(10) }),
  job({ id: 3, position: 2, quantity: 1, setupSeconds: min(16 * 60) }),
  job({ id: 1, position: 3, status: 'IN_PROGRESS', quantity: 40, setupSeconds: min(30), unitSeconds: min(5), internalPauseSeconds: min(15), endPauseSeconds: min(10), workedSeconds: worked }),
];

describe('tempo già lavorato da una fase', () => {
  it('somma attrezzaggio e lavorazione, compresa la fase in corso fino ad adesso', () => {
    expect(phaseWorkedSeconds(phases[0], NOW)).toBe(min(120));
    expect(phaseWorkedSeconds(phases[1], NOW)).toBe(min(60));
  });

  it("toglie i fermi: tutti nell'attrezzaggio, solo quelli a macchina ferma nella lavorazione", () => {
    const p = {
      ...phases[0],
      stops: [
        { startedAt: at('2026-11-04T10:10:00'), endedAt: at('2026-11-04T10:20:00'), machineStopped: false }, // pausa in attrezzaggio: si toglie
        { startedAt: at('2026-11-04T11:00:00'), endedAt: at('2026-11-04T11:15:00'), machineStopped: false }, // pausa operatore in lavorazione: no
        { startedAt: at('2026-11-04T11:30:00'), endedAt: at('2026-11-04T11:40:00'), machineStopped: true }, // guasto in lavorazione: si toglie
      ],
    };
    expect(phaseWorkedSeconds(p, NOW)).toBe(min(120 - 10 - 10));
  });
});

describe('pianificazione della coda di una macchina (esempio §4.7 corretto)', () => {
  const plan = planMachine(exampleJobs(), calendar(), NOW);
  const byId = Object.fromEntries(plan.jobs.map((j) => [j.id, j]));

  it('mette prima la lavorazione in corso e la fa finire adesso + residuo', () => {
    expect(plan.jobs.map((j) => j.id)).toEqual([1, 2, 3]);
    // richiesto 30 + 5×40 + 15 = 245 min; lavorato 3 h → residuo 65 min
    expect(byId[1].requiredSeconds).toBe(min(245));
    expect(byId[1].remainingSeconds).toBe(min(65));
    expect(byId[1].plannedStart).toEqual(NOW);
    expect(byId[1].plannedEnd).toEqual(at('2026-11-04T15:05:00'));
  });

  it('la successiva parte dopo la pausa di fine e prosegue il giorno dopo', () => {
    expect(byId[2].plannedStart).toEqual(at('2026-11-04T15:15:00'));
    // 6 h: mercoledì 1 h 15, giovedì 4 h 45
    expect(byId[2].plannedEnd).toEqual(at('2026-11-05T12:45:00'));
  });

  it('salta sabato e domenica (giorni senza orario)', () => {
    // 16 h da giovedì 12:45: giovedì 3 h 45, venerdì 8 h 30, lunedì 3 h 45
    expect(byId[3].plannedStart).toEqual(at('2026-11-05T12:45:00'));
    expect(byId[3].plannedEnd).toEqual(at('2026-11-09T11:45:00'));
  });

  it('totale coda in giorni lavorativi sull orario reale (8 h 30)', () => {
    // 65 + 10 (pausa fine) + 360 + 960 = 1395 min
    expect(plan.totalSeconds).toBe(min(1395));
    expect(plan.totalWorkingDays).toBeCloseTo(1395 / 510, 2);
    expect(plan.queueEnd).toEqual(at('2026-11-09T11:45:00'));
  });
});

describe('casi del calendario', () => {
  it('salta le chiusure straordinarie', () => {
    const plan = planMachine(exampleJobs(), calendar(['2026-11-06']), NOW);
    // venerdì chiuso: giovedì 3 h 45, lunedì 8 h 30, martedì 3 h 45
    expect(plan.jobs[2].plannedEnd).toEqual(at('2026-11-10T11:45:00'));
  });

  it("non parte mai prima dell'apertura", () => {
    const plan = planMachine([job({ id: 1, setupSeconds: min(60) })], calendar(), at('2026-11-04T06:00:00'));
    expect(plan.jobs[0].plannedStart).toEqual(at('2026-11-04T08:00:00'));
    expect(plan.jobs[0].plannedEnd).toEqual(at('2026-11-04T09:00:00'));
  });

  it("dopo la chiusura parte all'apertura del giorno lavorativo successivo", () => {
    const plan = planMachine([job({ id: 1, setupSeconds: min(30) })], calendar(), at('2026-11-06T18:00:00'));
    expect(plan.jobs[0].plannedStart).toEqual(at('2026-11-09T08:00:00'));
  });

  it("la pausa di fine lavorazione resta dentro l'orario", () => {
    const plan = planMachine(
      [job({ id: 1, setupSeconds: min(25), endPauseSeconds: min(10) }), job({ id: 2, setupSeconds: min(30) })],
      calendar(),
      at('2026-11-04T16:00:00'),
    );
    expect(plan.jobs[0].plannedEnd).toEqual(at('2026-11-04T16:25:00'));
    // 5 min di pausa mercoledì, 5 min giovedì
    expect(plan.jobs[1].plannedStart).toEqual(at('2026-11-05T08:05:00'));
  });

  it('residuo mai negativo e lavorazioni in corso mai sovrapposte', () => {
    const plan = planMachine(
      [
        job({ id: 1, status: 'IN_PROGRESS', setupSeconds: min(30), workedSeconds: min(90) }),
        job({ id: 2, status: 'IN_PROGRESS', setupSeconds: min(30) }),
      ],
      calendar(),
      NOW,
    );
    expect(plan.jobs[0].remainingSeconds).toBe(0);
    expect(plan.jobs[0].plannedEnd).toEqual(NOW);
    expect(plan.jobs[1].plannedStart).toEqual(NOW);
    expect(plan.jobs[1].plannedEnd).toEqual(at('2026-11-04T14:30:00'));
  });

  it("rispetta il cambio dell'ora legale", () => {
    // venerdì 23/10/2026 16:00 + 1 h → lunedì 26/10 08:30 (dopo il passaggio all'ora solare)
    const plan = planMachine([job({ id: 1, setupSeconds: min(60) })], calendar(), at('2026-10-23T16:00:00'));
    expect(plan.jobs[0].plannedEnd).toEqual(at('2026-10-26T08:30:00'));
    expect(plan.jobs[0].plannedEnd.toISOString()).toBe('2026-10-26T07:30:00.000Z');
  });

  it('senza giorni lavorativi segnala un errore chiaro', () => {
    const empty: WorkCalendar = { timeZone: TZ, closures: [], days: [{ weekday: 0, startTime: null, endTime: null }] };
    expect(() => planMachine([job({ id: 1 })], empty, NOW)).toThrow(CalendarError);
  });

  it('coda vuota', () => {
    const plan = planMachine([], calendar(), NOW);
    expect(plan.jobs).toEqual([]);
    expect(plan.totalWorkingDays).toBe(0);
    expect(plan.queueEnd).toBeNull();
  });
});
