/**
 * Calcolo di costi e prezzi di un preventivo (01-commerciale §1.4, con le correzioni decise):
 * - trattamenti con l'unità giusta: kg × €/kg, dm² × €/dm²;
 * - costo CAM compreso sia nel costo sia nel prezzo (report ed Excel danno lo stesso risultato);
 * - quantità da produrre 0: i costi fissi (CAM, programmazione, attrezzaggio) valgono 0 e si segnala un avviso;
 * - ogni voce è arrotondata a 2 decimali (metà per eccesso) prima di essere sommata.
 * Funzioni pure, senza accesso al database (testate in quote-costs.spec.ts).
 */
import type { TreatmentPriceUnit } from '../../shared';

/** Arrotondamento a 2 decimali, metà per eccesso (anche con gli errori di rappresentazione binaria). */
export function round2(v: number): number {
  if (!Number.isFinite(v)) return 0;
  const sign = v < 0 ? -1 : 1;
  return (sign * Math.round(Math.abs(v) * 100 + 1e-9)) / 100;
}

export interface CostPhaseInput {
  id?: number;
  machineTypeId: number;
  machineTypeName?: string;
  machineId?: number | null;
  machineName?: string | null;
  programmingSeconds: number;
  setupSeconds: number;
  unitSeconds: number;
  machineHourlyRate: number;
}

export interface CostTreatmentInput {
  id?: number;
  treatmentId: number;
  treatmentName?: string;
  unitPrice: number;
  unit: TreatmentPriceUnit;
}

export interface CostPartInput {
  /** Quantità da produrre (lotto). */
  productionQuantity: number;
  camSeconds: number;
  camPricePerMinute: number;
  materialPricePerKg: number;
  weightKg: number | null;
  treatmentKg: number | null;
  treatmentDm2: number | null;
  phases: CostPhaseInput[];
  treatments: CostTreatmentInput[];
}

export interface PhaseCost extends CostPhaseInput {
  programmingCost: number;
  setupCost: number;
  workCost: number;
  /** Costo della fase per pezzo. */
  cost: number;
  /** Tempo totale della fase per il lotto: programmazione + attrezzaggio + lavorazione × quantità. */
  totalSeconds: number;
}

export interface TreatmentCost extends CostTreatmentInput {
  /** kg o dm² da trattare usati nel calcolo. */
  dimension: number | null;
  cost: number;
}

export interface PartCost {
  materialCost: number;
  camCost: number;
  treatments: TreatmentCost[];
  treatmentsCost: number;
  phases: PhaseCost[];
  phasesCost: number;
  /** Costo per pezzo: materiale + CAM + fasi + trattamenti. */
  unitCost: number;
  /** Costo del lotto: costo per pezzo × quantità da produrre. */
  totalCost: number;
  /** Prezzo per pezzo: (materiale × ricarico materiale + CAM + fasi + trattamenti) × ricarico. */
  unitPrice: number;
  /** Prezzo del lotto. */
  totalPrice: number;
  /** Tempo totale del lotto (CAM + fasi). */
  totalSeconds: number;
  warnings: string[];
}

export interface Markups {
  materialMarkup: number;
  markup: number;
}

const n = (v: unknown) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? 0 : Number(v));

export function computePartCost(p: CostPartInput, m: Markups): PartCost {
  const warnings: string[] = [];
  const q = Math.max(0, Math.trunc(n(p.productionQuantity)));
  const hasFixed = n(p.camSeconds) > 0 || p.phases.some((f) => n(f.programmingSeconds) > 0 || n(f.setupSeconds) > 0);
  if (q === 0 && hasFixed) {
    warnings.push('Quantità da produrre 0: i tempi fissi (CAM, programmazione, attrezzaggio) non sono ripartiti e valgono 0.');
  }
  const perPiece = (seconds: number, ratePerSecond: number) => (q > 0 ? round2((n(seconds) * ratePerSecond) / q) : 0);

  const materialCost = round2(n(p.weightKg) * n(p.materialPricePerKg));
  if (p.weightKg === null || p.weightKg === undefined) {
    if (n(p.materialPricePerKg) > 0) warnings.push('Peso del particolare non indicato: costo materiale 0.');
  }
  const camCost = perPiece(p.camSeconds, n(p.camPricePerMinute) / 60);

  const phases: PhaseCost[] = p.phases.map((f) => {
    const rate = n(f.machineHourlyRate) / 3600;
    const programmingCost = perPiece(f.programmingSeconds, rate);
    const setupCost = perPiece(f.setupSeconds, rate);
    const workCost = round2(n(f.unitSeconds) * rate);
    return {
      ...f,
      programmingCost,
      setupCost,
      workCost,
      cost: round2(programmingCost + setupCost + workCost),
      totalSeconds: n(f.programmingSeconds) + n(f.setupSeconds) + n(f.unitSeconds) * q,
    };
  });
  const phasesCost = round2(phases.reduce((s, f) => s + f.cost, 0));

  const treatments: TreatmentCost[] = p.treatments.map((t) => {
    const dimension = t.unit === 'DM2' ? p.treatmentDm2 : p.treatmentKg;
    if ((dimension === null || dimension === undefined) && n(t.unitPrice) > 0) {
      warnings.push(`Trattamento ${t.treatmentName ?? t.treatmentId}: ${t.unit === 'DM2' ? 'dm²' : 'kg'} da trattare non indicati, costo 0.`);
    }
    return { ...t, dimension: dimension ?? null, cost: round2(n(dimension) * n(t.unitPrice)) };
  });
  const treatmentsCost = round2(treatments.reduce((s, t) => s + t.cost, 0));

  const unitCost = round2(materialCost + camCost + phasesCost + treatmentsCost);
  const unitPriceRaw = (materialCost * n(m.materialMarkup) + camCost + phasesCost + treatmentsCost) * n(m.markup);
  return {
    materialCost,
    camCost,
    treatments,
    treatmentsCost,
    phases,
    phasesCost,
    unitCost,
    totalCost: round2(unitCost * q),
    unitPrice: round2(unitPriceRaw),
    totalPrice: round2(unitPriceRaw * q),
    totalSeconds: n(p.camSeconds) + phases.reduce((s, f) => s + f.totalSeconds, 0),
    warnings,
  };
}

export interface QuoteTotals {
  materialCost: number;
  camCost: number;
  phasesCost: number;
  treatmentsCost: number;
  totalCost: number;
  totalPrice: number;
  totalSeconds: number;
}

/** Totali del preventivo: somma dei lotti (voci per pezzo × quantità da produrre). */
export function computeTotals(parts: { productionQuantity: number; cost: PartCost }[]): QuoteTotals {
  const t: QuoteTotals = { materialCost: 0, camCost: 0, phasesCost: 0, treatmentsCost: 0, totalCost: 0, totalPrice: 0, totalSeconds: 0 };
  for (const { productionQuantity, cost } of parts) {
    const q = Math.max(0, Math.trunc(n(productionQuantity)));
    t.materialCost += round2(cost.materialCost * q);
    t.camCost += round2(cost.camCost * q);
    t.phasesCost += round2(cost.phasesCost * q);
    t.treatmentsCost += round2(cost.treatmentsCost * q);
    t.totalCost += cost.totalCost;
    t.totalPrice += cost.totalPrice;
    t.totalSeconds += cost.totalSeconds;
  }
  for (const k of Object.keys(t) as (keyof QuoteTotals)[]) if (k !== 'totalSeconds') t[k] = round2(t[k]);
  return t;
}
