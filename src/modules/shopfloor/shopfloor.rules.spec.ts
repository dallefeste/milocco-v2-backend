import {
  barCutPlan, groupOrdersByMaterial, isResumed, MULTI_PART_GROUP, NO_MATERIAL_GROUP, NO_SUBGROUP_LABEL, pieceLengthMm,
  shapeFamily, splitDimensions, subgroupOf,
} from './shopfloor.rules';

describe('subgroupOf (sottogruppo dal codice ordine cliente)', () => {
  it('prende la parte prima dell\'ultimo "-"', () => {
    expect(subgroupOf('RHOSS-2024-15')).toBe('RHOSS-2024');
    expect(subgroupOf('ABC-1')).toBe('ABC');
    expect(subgroupOf('A - B - C')).toBe('A - B');
  });
  it('senza "-" restituisce il codice intero', () => {
    expect(subgroupOf('PROVA00')).toBe('PROVA00');
    expect(subgroupOf('  12345 ')).toBe('12345');
  });
  it('parte prima del "-" vuota o codice vuoto → "Non assegnato"', () => {
    expect(subgroupOf('-15')).toBe(NO_SUBGROUP_LABEL);
    expect(subgroupOf('')).toBe(NO_SUBGROUP_LABEL);
    expect(subgroupOf(null)).toBe(NO_SUBGROUP_LABEL);
  });
});

describe('taglio a barra (barra di riferimento 500 mm, +40 mm)', () => {
  it('calcola pezzi per barra, barre e lunghezza', () => {
    // L = 43: N = floor(500/43) = 11; 100 pezzi → ceil(100/11) = 10 barre; 43×11 + 40 = 513 mm
    const plan = barCutPlan(43, 100);
    expect(plan).toMatchObject({ ok: true, piecesPerBar: 11, bars: 10, barLengthMm: 513 });
    expect(plan.text).toBe('10 barre da 513 mm (Pezzi per barra: 11)');
  });
  it('quantità multipla esatta e pezzo da 500 mm', () => {
    expect(barCutPlan(100, 10)).toMatchObject({ piecesPerBar: 5, bars: 2, barLengthMm: 540 });
    expect(barCutPlan(500, 3)).toMatchObject({ ok: true, piecesPerBar: 1, bars: 3, barLengthMm: 540 });
  });
  it('lunghezza mancante, zero o oltre 500 mm → impossibile', () => {
    for (const l of [null, 0, 501]) {
      const plan = barCutPlan(l, 10);
      expect(plan.ok).toBe(false);
      expect(plan.text).toBe('Impossibile ricavare il numero di barre da utilizzare.');
    }
  });
  it('rispetta le impostazioni di barra e sovrametallo', () => {
    expect(barCutPlan(100, 10, 1000, 20)).toMatchObject({ piecesPerBar: 10, bars: 1, barLengthMm: 1020 });
  });
  it('lunghezza del pezzo: lunghezza di taglio o numero dopo l\'ultima "L" del testo dimensioni', () => {
    expect(pieceLengthMm(55, 'Barra circolare - d50 L43')).toBe(55);
    expect(pieceLengthMm(null, 'Barra circolare - d50 L43')).toBe(43);
    expect(pieceLengthMm(null, 'Angolare - L130 L230 t3 L250')).toBe(250);
    expect(pieceLengthMm(null, 'Barra piatta - a20 b10 L12,5')).toBe(12.5);
    expect(pieceLengthMm(null, 'A Disegno')).toBeNull();
    expect(pieceLengthMm(null, null)).toBeNull();
  });
});

describe('raggruppamento ordini per materiale (A7)', () => {
  const order = (id: number, drawingCode: string, parts: [number, number | null, string | null][]) => ({
    id, drawingCode, parts: parts.map(([partId, materialId, materialName]) => ({ partId, materialId, materialName })),
  });
  it('ogni ordine compare una sola volta', () => {
    const groups = groupOrdersByMaterial([
      order(1, 'B', [[10, 1, 'Ottone']]),
      order(2, 'A', [[11, 2, 'Acciaio'], [12, 1, 'Ottone']]),
      order(3, 'A', [[13, 1, 'Ottone']]),
      order(4, 'C', [[14, null, null]]),
      order(5, 'D', [[15, 2, 'Acciaio'], [15, 2, 'Acciaio']]),
    ]);
    expect(groups.map((g) => g.label)).toEqual(['Acciaio', 'Ottone', NO_MATERIAL_GROUP, MULTI_PART_GROUP]);
    expect(groups.flatMap((g) => g.orders.map((o) => o.id)).sort()).toEqual([1, 2, 3, 4, 5]);
    expect(groups[1].orders.map((o) => o.id)).toEqual([3, 1]);
    expect(groups[3].orders.map((o) => o.id)).toEqual([2]);
  });
});

describe('altre regole', () => {
  it('fase già ripresa: considera ordine, particolare e numero (A5)', () => {
    const a = { id: 1, productionOrderId: 7, partId: 100, phaseNumber: 1, resumedFromId: null };
    const otherPart = { id: 2, productionOrderId: 7, partId: 200, phaseNumber: 1, resumedFromId: null };
    expect(isResumed(a, [a, otherPart])).toBe(false);
    const resume = { id: 3, productionOrderId: 7, partId: 100, phaseNumber: 1, resumedFromId: 1 };
    expect(isResumed(a, [a, otherPart, resume])).toBe(true);
  });
  it('forma e dimensioni', () => {
    expect(splitDimensions('Barra circolare - d50 L43')).toEqual({ shape: 'Barra circolare', size: 'd50 L43' });
    expect(shapeFamily('TO', null, null)).toBe('ROUND');
    expect(shapeFamily(null, null, 'Foglio/Lamiera - t2 w100 L200')).toBe('SHEET');
    expect(shapeFamily(null, null, 'Tubo rettangolare - h20 w10 t2 L100')).toBe('RECT_TUBE');
  });
});
