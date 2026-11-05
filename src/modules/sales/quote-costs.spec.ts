import { computePartCost, computeTotals, CostPartInput, round2 } from './quote-costs';

/** Esempio numerico di 01-commerciale §1.4. */
const example = (): CostPartInput => ({
  productionQuantity: 50,
  camSeconds: 1800,
  camPricePerMinute: 1,
  materialPricePerKg: 3.4,
  weightKg: 2.5,
  treatmentKg: 2.5,
  treatmentDm2: 12,
  phases: [
    { machineTypeId: 2, programmingSeconds: 3600, setupSeconds: 1800, unitSeconds: 360, machineHourlyRate: 50 },
    { machineTypeId: 1, programmingSeconds: 0, setupSeconds: 0, unitSeconds: 180, machineHourlyRate: 50 },
  ],
  treatments: [{ treatmentId: 1, unitPrice: 2, unit: 'KG' }],
});
const markups = { materialMarkup: 1.15, markup: 1.25 };

describe('round2', () => {
  it('arrotonda metà per eccesso', () => {
    expect(round2(1.005)).toBe(1.01);
    expect(round2(2.675)).toBe(2.68);
    expect(round2(0.125)).toBe(0.13);
    expect(round2(1523.4375)).toBe(1523.44);
    expect(round2(-1.005)).toBe(-1.01);
    expect(round2(NaN)).toBe(0);
  });
});

describe('costi di una riga del preventivo', () => {
  it('riproduce le voci dell\'esempio della specifica', () => {
    const c = computePartCost(example(), markups);
    expect(c.materialCost).toBe(8.5);
    expect(c.camCost).toBe(0.6);
    expect(c.phases[0].programmingCost).toBe(1);
    expect(c.phases[0].setupCost).toBe(0.5);
    expect(c.phases[0].workCost).toBe(5);
    expect(c.phases[1].workCost).toBe(2.5);
    expect(c.phasesCost).toBe(9);
    expect(c.treatmentsCost).toBe(5);
    expect(c.warnings).toEqual([]);
  });

  it('include il CAM nel costo e nel prezzo (stesso risultato dell\'Excel)', () => {
    const c = computePartCost(example(), markups);
    expect(c.unitCost).toBe(23.1); // 8,50 + 0,60 + 9,00 + 5,00
    expect(c.totalCost).toBe(1155);
    expect(c.unitPrice).toBe(30.47); // (9,775 + 14,60) × 1,25
    expect(c.totalPrice).toBe(1523.44);
  });

  it('usa i kg per l\'unità €/kg e i dm² per l\'unità €/dm²', () => {
    const kg = computePartCost(example(), markups);
    expect(kg.treatments[0].dimension).toBe(2.5);
    expect(kg.treatments[0].cost).toBe(5);
    const p = example();
    p.treatments = [{ treatmentId: 1, unitPrice: 2, unit: 'DM2' }];
    const dm2 = computePartCost(p, markups);
    expect(dm2.treatments[0].dimension).toBe(12);
    expect(dm2.treatments[0].cost).toBe(24);
  });

  it('con quantità da produrre 0 non divide per zero: costi fissi 0 e avviso', () => {
    const p = example();
    p.productionQuantity = 0;
    const c = computePartCost(p, markups);
    expect(c.camCost).toBe(0);
    expect(c.phases[0].programmingCost).toBe(0);
    expect(c.phases[0].setupCost).toBe(0);
    expect(c.phases[0].workCost).toBe(5); // la lavorazione è già per pezzo
    expect(c.totalCost).toBe(0);
    expect(c.totalPrice).toBe(0);
    expect(c.warnings.length).toBe(1);
    expect(Number.isFinite(c.unitCost)).toBe(true);
  });

  it('arrotonda ogni voce prima di sommarla', () => {
    const c = computePartCost(
      { productionQuantity: 3, camSeconds: 0, camPricePerMinute: 0, materialPricePerKg: 0, weightKg: null, treatmentKg: null, treatmentDm2: null, treatments: [],
        phases: [
          { machineTypeId: 1, programmingSeconds: 0, setupSeconds: 100, unitSeconds: 0, machineHourlyRate: 36 }, // 100 × 0,01 / 3 = 0,333 → 0,33
          { machineTypeId: 1, programmingSeconds: 0, setupSeconds: 100, unitSeconds: 0, machineHourlyRate: 36 },
        ] },
      markups,
    );
    expect(c.phasesCost).toBe(0.66); // non 0,67
  });

  it('senza peso o senza dimensioni di trattamento vale 0 con avviso', () => {
    const p = example();
    p.weightKg = null;
    p.treatmentKg = null;
    const c = computePartCost(p, markups);
    expect(c.materialCost).toBe(0);
    expect(c.treatmentsCost).toBe(0);
    expect(c.warnings.length).toBe(2);
  });

  it('calcola i tempi del lotto', () => {
    const c = computePartCost(example(), markups);
    expect(c.phases[0].totalSeconds).toBe(3600 + 1800 + 360 * 50);
    expect(c.totalSeconds).toBe(1800 + 3600 + 1800 + 360 * 50 + 180 * 50);
  });
});

describe('totali del preventivo', () => {
  it('somma i lotti', () => {
    const a = computePartCost(example(), markups);
    const p2 = example();
    p2.productionQuantity = 10;
    const b = computePartCost(p2, markups);
    const t = computeTotals([{ productionQuantity: 50, cost: a }, { productionQuantity: 10, cost: b }]);
    expect(t.totalCost).toBe(round2(a.totalCost + b.totalCost));
    expect(t.totalPrice).toBe(round2(a.totalPrice + b.totalPrice));
    expect(t.materialCost).toBe(8.5 * 60);
  });
});
