import { matchProgress } from './customer-order-report.service';

const step = (partId: number, machineTypeId: number, sequence: number) => ({ partId, partCode: `P${partId}`, machineTypeId, machineTypeName: `T${machineTypeId}`, sequence });
const phase = (id: number, partId: number | null, machineTypeId: number, status: 'COMPLETED' | 'IN_PROGRESS' | 'SUSPENDED', at: string, resumedFromId: number | null = null) => ({
  id, partId, machineTypeId, status, resumedFromId, setupStartedAt: new Date(`2019-11-05T${at}:00Z`),
});

describe("avanzamento ordine: confronto ciclo previsto / fasi registrate", () => {
  const steps = [step(1, 10, 1), step(1, 20, 2), step(2, 10, 1), step(2, 30, 2)];

  it('pesi 1 per conclusa, 0,5 per in corso, 0 per da fare', () => {
    const r = matchProgress(steps, [phase(1, 1, 10, 'COMPLETED', '08:00'), phase(2, 1, 20, 'IN_PROGRESS', '09:00')]);
    expect(r.expected).toBe(4);
    expect(r.weight).toBe(1.5);
    expect(r.progress).toBe(0.38);
    expect(r.steps.map((s) => s.state)).toEqual(['DONE', 'IN_PROGRESS', 'TODO', 'TODO']);
  });

  it('una fase sospesa e poi ripresa conta una volta sola', () => {
    const r = matchProgress(steps, [phase(1, 1, 10, 'SUSPENDED', '08:00'), phase(2, 1, 10, 'COMPLETED', '10:00', 1)]);
    expect(r.weight).toBe(1);
    expect(r.unmatchedPhases).toBe(0);
  });

  it('sospesa non ripresa vale 0,5', () => {
    const r = matchProgress(steps, [phase(1, 2, 30, 'SUSPENDED', '08:00')]);
    expect(r.steps[3].state).toBe('IN_PROGRESS');
  });

  it('fasi in più del previsto non superano il 100%', () => {
    const many = [1, 2, 3, 4, 5, 6].map((i) => phase(i, 1, 10, 'COMPLETED', `0${i}:00`));
    const r = matchProgress([step(1, 10, 1)], many);
    expect(r.progress).toBe(1);
    expect(r.unmatchedPhases).toBe(5);
  });

  it('fase senza particolare si assegna al primo passo libero della stessa tipologia', () => {
    const r = matchProgress(steps, [phase(1, null, 10, 'COMPLETED', '08:00'), phase(2, null, 10, 'COMPLETED', '09:00')]);
    expect(r.steps.filter((s) => s.state === 'DONE').map((s) => s.partId)).toEqual([1, 2]);
  });

  it('fase su tipologia diversa dal ciclo copre la prima fase libera dello stesso particolare', () => {
    const r = matchProgress(steps, [phase(1, 2, 99, 'COMPLETED', '08:00')]);
    expect(r.steps.map((s) => s.state)).toEqual(['TODO', 'TODO', 'DONE', 'TODO']);
    expect(r.unmatchedPhases).toBe(0);
  });

  it('i collaudi (id negativi) coprono solo le fasi di collaudo', () => {
    const withInsp = [step(1, 10, 1), { ...step(1, 60, 2), isInspection: true }];
    const r = matchProgress(withInsp, [phase(-5, null, 60, 'COMPLETED', '10:00'), phase(-6, null, 60, 'COMPLETED', '11:00'), phase(1, 1, 20, 'COMPLETED', '08:00')]);
    expect(r.steps.map((s) => s.state)).toEqual(['DONE', 'DONE']);
    const r2 = matchProgress(withInsp, [phase(1, 1, 10, 'COMPLETED', '08:00'), phase(2, 1, 10, 'COMPLETED', '09:00')]);
    expect(r2.steps[1].state).toBe('TODO');
    expect(r2.unmatchedPhases).toBe(1);
  });

  it('ordine completato = 100%; nessun ciclo = 0%', () => {
    const done = matchProgress(steps, [], true);
    expect(done.progress).toBe(1);
    expect(done.steps.every((s) => s.state === 'DONE' && s.assumed)).toBe(true);
    expect(matchProgress([], []).progress).toBe(0);
  });
});
