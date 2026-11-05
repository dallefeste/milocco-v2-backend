/**
 * Regole pure delle code ordinate (lavorazioni per macchina e coda di taglio) e della disponibilità
 * materiale per il taglio. Nessun accesso al database: testate in queue-rules.spec.ts.
 */

/**
 * Valore provvisorio di posizione prima della rinumerazione 1..n (02-produzione §4.4).
 * - `requested`: posizione indicata dall'utente (1 = in testa), null/undefined = in fondo;
 * - `currentRank`: posizione attuale se l'elemento è già nella stessa coda.
 */
export function provisionalPosition(opts: { requested?: number | null; currentRank?: number | null; maxPosition: number }): number {
  const { requested, currentRank, maxPosition } = opts;
  if (requested == null || !Number.isFinite(requested)) return maxPosition + 1;
  const p = Math.max(1, Math.floor(requested));
  if (currentRank != null) return p >= currentRank ? p + 0.5 : p - 0.5;
  return p - 0.5;
}

export type CutAvailabilityState = 'AVAILABLE' | 'INSUFFICIENT' | 'NO_BAR_TYPE' | 'NO_LENGTH';

export interface CutAvailabilityInput {
  id: number;
  barTypeId: number | null;
  cutLengthMm: number | null;
  orderQuantity: number;
  quantityPerUnit: number;
}

export interface CutAvailability {
  state: CutAvailabilityState;
  /** Metri lineari necessari (null se non calcolabili). */
  neededMeters: number | null;
  /** Giacenza ancora libera prima di questa riga (dopo le righe precedenti della coda). */
  availableMeters: number | null;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Disponibilità barre per le righe della coda di taglio, nell'ordine dato (02-produzione §5.5 corretto):
 * metri necessari = lunghezza di taglio (mm) × quantità ordine × quantità del particolare / 1000;
 * la giacenza di ogni tipologia viene "prenotata" riga per riga nell'ordine della coda.
 * Una riga senza tipologia barra o senza lunghezza non interrompe mai il calcolo delle altre.
 */
export function computeCutAvailability(rows: CutAvailabilityInput[], stockByBarType: Map<number, number>): Map<number, CutAvailability> {
  const left = new Map(stockByBarType);
  const out = new Map<number, CutAvailability>();
  for (const r of rows) {
    if (r.barTypeId == null) {
      out.set(r.id, { state: 'NO_BAR_TYPE', neededMeters: null, availableMeters: null });
      continue;
    }
    const available = round3(left.get(r.barTypeId) ?? 0);
    if (r.cutLengthMm == null || !(r.cutLengthMm > 0)) {
      out.set(r.id, { state: 'NO_LENGTH', neededMeters: null, availableMeters: available });
      continue;
    }
    const needed = round3((r.cutLengthMm * Math.max(0, r.orderQuantity) * Math.max(0, r.quantityPerUnit)) / 1000);
    if (available >= needed) {
      left.set(r.barTypeId, round3(available - needed));
      out.set(r.id, { state: 'AVAILABLE', neededMeters: needed, availableMeters: available });
    } else {
      out.set(r.id, { state: 'INSUFFICIENT', neededMeters: needed, availableMeters: available });
    }
  }
  return out;
}

/** Divide il testo dimensioni del particolare in forma e misure ("Barra circolare - d50 L43"). */
export function splitDimensions(text: string | null | undefined): { shape: string | null; size: string | null } {
  if (!text) return { shape: null, size: null };
  const i = text.indexOf(' - ');
  if (i < 0) return { shape: null, size: text.trim() || null };
  return { shape: text.slice(0, i).trim() || null, size: text.slice(i + 3).trim() || null };
}
