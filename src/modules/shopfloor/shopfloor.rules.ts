/**
 * Regole di calcolo dell'app tablet, senza dipendenze dal database (testate in shopfloor.rules.spec.ts).
 */

export const NO_SUBGROUP_LABEL = 'Non assegnato';

/**
 * Sottogruppo di un ordine cliente, ricavato dal suo codice (04-tablet §4.1):
 * - se il codice contiene "-": la parte prima dell'ULTIMO "-" (se vuota → "Non assegnato");
 * - se non contiene "-": il codice intero;
 * - codice vuoto → "Non assegnato".
 */
export function subgroupOf(code: string | null | undefined): string {
  const value = (code ?? '').trim();
  if (!value) return NO_SUBGROUP_LABEL;
  const idx = value.lastIndexOf('-');
  if (idx < 0) return value;
  const head = value.slice(0, idx).trim();
  return head || NO_SUBGROUP_LABEL;
}

/** Ordina testi in ordine alfabetico italiano, senza distinzione maiuscole/minuscole. */
export const compareIt = (a: string, b: string): number => a.localeCompare(b, 'it', { sensitivity: 'base', numeric: true });

/**
 * Lunghezza del pezzo (mm) per il taglio a barra.
 * Si usa la lunghezza di taglio del particolare; se manca, il numero dopo l'ULTIMA "L" del testo dimensioni
 * (es. "Barra circolare - d50 L43" → 43). L'ultima occorrenza evita di leggere L1/L2 degli angolari.
 */
export function pieceLengthMm(cutLengthMm: number | null | undefined, dimensions: string | null | undefined): number | null {
  if (cutLengthMm !== null && cutLengthMm !== undefined && Number(cutLengthMm) > 0) return Number(cutLengthMm);
  const text = dimensions ?? '';
  const matches = [...text.matchAll(/(?:^|[^A-Za-z0-9])L\s*(\d+(?:[.,]\d+)?)(?![0-9])/g)];
  if (!matches.length) return null;
  const last = matches[matches.length - 1][1].replace(',', '.');
  const value = Number(last);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export interface BarCutPlan {
  ok: boolean;
  /** Lunghezza del pezzo (mm). */
  pieceLengthMm: number | null;
  /** Pezzi ricavabili da una barra di riferimento. */
  piecesPerBar: number;
  /** Barre da tagliare. */
  bars: number;
  /** Lunghezza di ogni barra da tagliare (mm). */
  barLengthMm: number;
  /** Testo mostrato all'operatore. */
  text: string;
}

/**
 * Taglio a barra (04-tablet §6): barra di riferimento R (500 mm), sovrametallo E (40 mm).
 * N = parte intera di R / L; n = arrotondamento per eccesso di (quantità / N); lunghezza barra = L × N + E.
 * Se L manca, è 0 o supera R: calcolo impossibile.
 */
export function barCutPlan(pieceLength: number | null, totalQuantity: number, referenceMm = 500, extraMm = 40): BarCutPlan {
  const fail: BarCutPlan = {
    ok: false, pieceLengthMm: pieceLength, piecesPerBar: 0, bars: 0, barLengthMm: 0,
    text: 'Impossibile ricavare il numero di barre da utilizzare.',
  };
  if (!pieceLength || pieceLength <= 0 || pieceLength > referenceMm) return fail;
  const piecesPerBar = Math.floor(referenceMm / pieceLength);
  if (piecesPerBar <= 0) return fail;
  const bars = Math.ceil(Math.max(0, totalQuantity) / piecesPerBar);
  const barLengthMm = Math.round((pieceLength * piecesPerBar + extraMm) * 100) / 100;
  return {
    ok: true, pieceLengthMm: pieceLength, piecesPerBar, bars, barLengthMm,
    text: `${bars} barre da ${fmtNum(barLengthMm)} mm (Pezzi per barra: ${piecesPerBar})`,
  };
}

const fmtNum = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, '').replace('.', ','));

export interface OrderPartForGrouping {
  partId: number;
  materialId: number | null;
  materialName: string | null;
}

export interface OrderGroup<T> {
  key: string;
  label: string;
  orders: T[];
}

export const MULTI_PART_GROUP = 'Più particolari';
export const NO_MATERIAL_GROUP = 'Materiale non indicato';

/**
 * Raggruppa gli ordini per materiale (correzione A7): ogni ordine compare UNA sola volta.
 * - disegno con un solo particolare → gruppo del materiale di quel particolare;
 * - disegno con più particolari → gruppo "Più particolari";
 * - particolare senza materiale → "Materiale non indicato" (prima venivano nascosti).
 * Ordine dei gruppi: materiali in ordine alfabetico, poi "Materiale non indicato", poi "Più particolari".
 * Dentro il gruppo: per codice disegno, poi numero ordine.
 */
export function groupOrdersByMaterial<T extends { id: number; drawingCode: string; parts: OrderPartForGrouping[] }>(orders: T[]): OrderGroup<T>[] {
  const groups = new Map<string, OrderGroup<T>>();
  for (const order of orders) {
    const distinctParts = new Map(order.parts.map((p) => [p.partId, p]));
    let key: string;
    let label: string;
    if (distinctParts.size > 1) {
      key = 'multi';
      label = MULTI_PART_GROUP;
    } else {
      const only = [...distinctParts.values()][0];
      if (only?.materialId) {
        key = `m${only.materialId}`;
        label = only.materialName ?? `Materiale ${only.materialId}`;
      } else {
        key = 'none';
        label = NO_MATERIAL_GROUP;
      }
    }
    if (!groups.has(key)) groups.set(key, { key, label, orders: [] });
    groups.get(key)!.orders.push(order);
  }
  const rank = (g: OrderGroup<T>) => (g.key === 'multi' ? 2 : g.key === 'none' ? 1 : 0);
  const result = [...groups.values()].sort((a, b) => rank(a) - rank(b) || compareIt(a.label, b.label));
  for (const g of result) g.orders.sort((a, b) => compareIt(a.drawingCode, b.drawingCode) || a.id - b.id);
  return result;
}

/** Famiglia della forma per l'immagine nella coda di taglio. */
export type ShapeFamily = 'SHEET' | 'ROUND' | 'FLAT' | 'SQUARE' | 'HEX' | 'TUBE' | 'RECT_TUBE' | 'U' | 'ANGLE' | 'BEAM' | 'OTHER';

/**
 * Ricava la famiglia della forma dal codice forma della barra (TO, PI, …), dalla forma del calcolatore peso
 * del particolare o dal testo dimensioni ("Barra circolare - …").
 */
export function shapeFamily(barShape: string | null | undefined, partShape: string | null | undefined, dimensions: string | null | undefined): ShapeFamily {
  const byBar: Record<string, ShapeFamily> = {
    TO: 'ROUND', AS: 'ROUND', PI: 'FLAT', PA: 'SHEET', QU: 'SQUARE', ES: 'HEX', TT: 'TUBE', TQ: 'RECT_TUBE', TR: 'RECT_TUBE',
    UN: 'U', AN: 'ANGLE', IN: 'BEAM', IP: 'BEAM', HA: 'BEAM', HB: 'BEAM', AA: 'BEAM', HM: 'BEAM',
  };
  if (barShape && byBar[barShape.toUpperCase()]) return byBar[barShape.toUpperCase()];
  const text = `${partShape ?? ''} ${(dimensions ?? '').split(' - ')[0]}`.toLowerCase();
  if (/lamier|foglio|sheet|plate/.test(text)) return 'SHEET';
  if (/rettangol|rect/.test(text)) return 'RECT_TUBE';
  if (/tubo|tube|pipe/.test(text)) return 'TUBE';
  if (/circolar|tond|round/.test(text)) return 'ROUND';
  if (/piatt|flat/.test(text)) return 'FLAT';
  if (/quadr|square/.test(text)) return 'SQUARE';
  if (/esagon|hex/.test(text)) return 'HEX';
  if (/profilo a u|\bu\b|channel|u_profile/.test(text)) return 'U';
  if (/angol|angle/.test(text)) return 'ANGLE';
  return 'OTHER';
}

/** Divide il testo dimensioni "Forma - misure" in forma e misure. */
export function splitDimensions(dimensions: string | null | undefined): { shape: string; size: string } {
  const text = (dimensions ?? '').trim();
  const idx = text.indexOf(' - ');
  if (idx < 0) return { shape: '', size: text };
  return { shape: text.slice(0, idx).trim(), size: text.slice(idx + 3).trim() };
}

/** Converte millimetri digitati sul tablet in metri lineari di magazzino. */
export const mmToMeters = (mm: number): number => Math.round(mm) / 1000;
/** Converte metri di magazzino in millimetri interi da mostrare. */
export const metersToMm = (m: number | null | undefined): number => Math.round(Number(m ?? 0) * 1000);

/** Una fase sospesa è "già ripresa" se esiste una fase che la riprende (stesso ordine, particolare e numero, A5). */
export function isResumed(
  phase: { id: number; productionOrderId: number; partId: number | null; phaseNumber: number },
  all: { id: number; productionOrderId: number; partId: number | null; phaseNumber: number; resumedFromId: number | null }[],
): boolean {
  return all.some((r) => r.id !== phase.id && (
    r.resumedFromId === phase.id ||
    (r.resumedFromId === null && r.productionOrderId === phase.productionOrderId && r.partId === phase.partId && r.phaseNumber === phase.phaseNumber && r.id > phase.id)
  ));
}
