import { addTimes, computePhaseTimes, emptyTotals, formatHms, mergeIntervals, percent, resolveInterval, round2 } from './time-calc';

const t = (hhmm: string) => new Date(`2019-11-05T${hhmm}:00Z`);

describe('time-calc: regola unica dei tempi netti', () => {
  it('calcola i tempi lordi senza fermi', () => {
    const r = computePhaseTimes({ setupStartedAt: t('08:00'), setupEndedAt: t('08:30'), workStartedAt: t('08:40'), workEndedAt: t('10:40'), goodQty: 10, scrapQty: 0 });
    expect(r.setupNet).toBe(1800);
    expect(r.workNet).toBe(7200);
    expect(r.intermediate).toBe(600);
    expect(r.total).toBe(9000);
    expect(r.overall).toBe(9600);
    expect(r.avgUnitSeconds).toBe(720);
    expect(r.open).toBe(false);
    expect(r.invalid).toBe(false);
  });

  it("toglie dall'attrezzaggio ogni fermo contenuto, anche con macchina che lavora", () => {
    const r = computePhaseTimes({
      setupStartedAt: t('08:00'), setupEndedAt: t('09:00'), workStartedAt: null, workEndedAt: null,
      stops: [{ startedAt: t('08:10'), endedAt: t('08:20'), machineStopped: false, isPause: true }],
    });
    expect(r.setupNet).toBe(3000);
    expect(r.setupStops).toBe(600);
    expect(r.pauseSeconds).toBe(600);
  });

  it('toglie dalla lavorazione solo i fermi con macchina ferma', () => {
    const r = computePhaseTimes({
      setupStartedAt: t('08:00'), setupEndedAt: t('08:30'), workStartedAt: t('08:30'), workEndedAt: t('12:00'),
      stops: [
        { startedAt: t('10:00'), endedAt: t('10:15'), machineStopped: false, isPause: true }, // pausa caffè, macchina lavora
        { startedAt: t('11:00'), endedAt: t('11:30'), machineStopped: true }, // guasto
      ],
    });
    expect(r.workNet).toBe(3.5 * 3600 - 1800);
    expect(r.machineStopSeconds).toBe(1800);
    expect(r.pauseSeconds).toBe(900);
    expect(r.stopSeconds).toBe(2700);
    expect(r.total).toBe(r.setupNet + r.workNet);
  });

  it('divide un fermo a cavallo tra attrezzaggio e lavorazione', () => {
    const r = computePhaseTimes({
      setupStartedAt: t('08:00'), setupEndedAt: t('09:00'), workStartedAt: t('09:00'), workEndedAt: t('10:00'),
      stops: [{ startedAt: t('08:50'), endedAt: t('09:20'), machineStopped: true }],
    });
    expect(r.setupNet).toBe(3000);
    expect(r.workNet).toBe(2400);
  });

  it('conta una volta sola fermi sovrapposti', () => {
    const r = computePhaseTimes({
      setupStartedAt: t('08:00'), setupEndedAt: t('08:00'), workStartedAt: t('08:00'), workEndedAt: t('10:00'),
      stops: [
        { startedAt: t('08:30'), endedAt: t('09:00'), machineStopped: true },
        { startedAt: t('08:45'), endedAt: t('09:15'), machineStopped: true },
      ],
    });
    expect(r.workNet).toBe(7200 - 2700);
  });

  it('ignora i fermi fuori dagli intervalli', () => {
    const r = computePhaseTimes({
      setupStartedAt: t('08:00'), setupEndedAt: t('08:30'), workStartedAt: t('09:00'), workEndedAt: t('10:00'),
      stops: [{ startedAt: t('08:35'), endedAt: t('08:55'), machineStopped: true }],
    });
    expect(r.setupNet).toBe(1800);
    expect(r.workNet).toBe(3600);
    expect(r.machineStopSeconds).toBe(1200);
  });

  it('fase aperta senza openUntil: tempi aperti a zero e marcata open', () => {
    const r = computePhaseTimes({ setupStartedAt: t('08:00'), setupEndedAt: t('08:30'), workStartedAt: t('08:30'), workEndedAt: null });
    expect(r.open).toBe(true);
    expect(r.setupNet).toBe(1800);
    expect(r.workNet).toBe(0);
  });

  it('fase aperta con openUntil: troncata a quell\'istante, fermo aperto incluso', () => {
    const r = computePhaseTimes(
      { setupStartedAt: t('08:00'), setupEndedAt: t('08:30'), workStartedAt: t('08:30'), workEndedAt: null, stops: [{ startedAt: t('09:00'), endedAt: null, machineStopped: true }] },
      { openUntil: t('09:30') },
    );
    expect(r.open).toBe(true);
    expect(r.workNet).toBe(1800);
  });

  it('fermo senza fine in fase chiusa: ignorato', () => {
    const r = computePhaseTimes(
      { setupStartedAt: t('08:00'), setupEndedAt: t('08:30'), workStartedAt: t('08:30'), workEndedAt: t('09:30'), stops: [{ startedAt: t('09:00'), endedAt: null, machineStopped: true }] },
      { openUntil: t('12:00') },
    );
    expect(r.workNet).toBe(3600);
    expect(r.stopCount).toBe(1);
  });

  it('orari incoerenti (fine prima dell\'inizio): intervallo ignorato e fase marcata invalid', () => {
    const r = computePhaseTimes({ setupStartedAt: t('09:00'), setupEndedAt: t('08:00'), workStartedAt: t('09:00'), workEndedAt: t('10:00') });
    expect(r.invalid).toBe(true);
    expect(r.setupNet).toBe(0);
    expect(r.workNet).toBe(3600);
    expect(r.intermediate).toBe(0);
  });

  it('tempo intermedio negativo conserva il segno', () => {
    const r = computePhaseTimes({ setupStartedAt: t('08:00'), setupEndedAt: t('09:00'), workStartedAt: t('08:50'), workEndedAt: t('10:00') });
    expect(r.intermediate).toBe(-600);
    expect(r.overall).toBe(r.total - 600);
  });

  it('il netto non è mai negativo', () => {
    const r = computePhaseTimes({
      setupStartedAt: t('08:00'), setupEndedAt: t('08:10'), workStartedAt: null, workEndedAt: null,
      stops: [{ startedAt: t('07:00'), endedAt: t('09:00'), machineStopped: true }],
    });
    expect(r.setupNet).toBe(0);
  });

  it('tempo medio unitario usa la quantità prevista se non ci sono pezzi', () => {
    const r = computePhaseTimes({ setupStartedAt: t('08:00'), setupEndedAt: t('08:00'), workStartedAt: t('08:00'), workEndedAt: t('09:00') }, { plannedQty: 4 });
    expect(r.avgUnitSeconds).toBe(900);
    const r2 = computePhaseTimes({ setupStartedAt: t('08:00'), setupEndedAt: t('08:00'), workStartedAt: t('08:00'), workEndedAt: t('09:00') });
    expect(r2.avgUnitSeconds).toBeNull();
  });

  it('somma i totali di più fasi', () => {
    const a = computePhaseTimes({ setupStartedAt: t('08:00'), setupEndedAt: t('08:30'), workStartedAt: t('08:30'), workEndedAt: t('09:00') });
    const acc = addTimes(addTimes(emptyTotals(), a), a);
    expect(acc.total).toBe(7200);
    expect(acc.phases).toBe(2);
  });

  it('utilità: intervalli, percentuali, arrotondamenti, formato durata', () => {
    expect(resolveInterval(null, null).interval).toBeNull();
    expect(mergeIntervals([[0, 10], [5, 20], [30, 40]])).toEqual([[0, 20], [30, 40]]);
    expect(percent(1, 3)).toBe(33.33);
    expect(percent(1, 0)).toBe(0);
    expect(round2(1.005)).toBe(1.01);
    expect(formatHms(26 * 3600 + 61)).toBe('26:01:01');
    expect(formatHms(-90)).toBe('-0:01:30');
  });
});
