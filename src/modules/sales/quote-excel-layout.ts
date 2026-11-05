/**
 * Disposizione fissa delle colonne del file Excel del preventivo (01-commerciale §1.6–1.7).
 * Export e import usano la stessa tabella, così un file esportato si può reimportare.
 *
 * Le tipologie macchina finiscono nelle colonne in base a `machine_type.excel_column`
 * (valori riconosciuti: le chiavi di EXCEL_SLOTS o i nomi in `names`, es. FORATURA → colonna "Trap.";
 * altri valori come RETTIFICA o COLLAUDO vanno in "Altre lav."). Se nessuna tipologia ha la colonna
 * impostata si usa il nome della tipologia (vedi docs/decisioni.md).
 */
export type ExcelSlotKey = 'TAGLIO' | 'FRESATURA' | 'TORNITURA' | 'ELETTROEROSIONE' | 'TRAPANATURA' | 'STOZZATURA' | 'SALDATURA' | 'DIMATURA';

export interface ExcelSlot {
  key: ExcelSlotKey;
  label: string;
  /** Tre colonne (programmazione, attrezzaggio, lavorazione) o solo lavorazione. */
  full: boolean;
  /** Colonne del foglio Tempi: [prg, attr, lav] o [lav]. */
  timeCols: string[];
  /** Colonne del foglio Costi. */
  costCols: string[];
  /** Nomi di tipologia riconosciuti quando excel_column non è configurata. */
  names: string[];
}

export const EXCEL_SLOTS: ExcelSlot[] = [
  { key: 'TAGLIO', label: 'Taglio', full: false, timeCols: ['N'], costCols: ['L'], names: ['taglio'] },
  { key: 'FRESATURA', label: 'Fresatura', full: true, timeCols: ['O', 'P', 'Q'], costCols: ['M', 'N', 'O'], names: ['fresatura'] },
  { key: 'TORNITURA', label: 'Tornitura', full: true, timeCols: ['R', 'S', 'T'], costCols: ['P', 'Q', 'R'], names: ['tornitura'] },
  { key: 'ELETTROEROSIONE', label: 'Elettroeros.', full: true, timeCols: ['U', 'V', 'W'], costCols: ['S', 'T', 'U'], names: ['elettroerosione'] },
  { key: 'TRAPANATURA', label: 'Trap.', full: false, timeCols: ['X'], costCols: ['V'], names: ['trapanatura', 'foratura', 'tranciatura'] },
  { key: 'STOZZATURA', label: 'Stozza', full: false, timeCols: ['Y'], costCols: ['W'], names: ['stozzatura'] },
  { key: 'SALDATURA', label: 'Saldatura', full: false, timeCols: ['Z'], costCols: ['X'], names: ['saldatura'] },
  { key: 'DIMATURA', label: 'Dima', full: false, timeCols: ['AA'], costCols: ['Y'], names: ['dimatura'] },
];

export const EXCEL_SLOT_KEYS = EXCEL_SLOTS.map((s) => s.key);

/** Prima riga dei dati (righe 3–5 = intestazioni). */
export const FIRST_DATA_ROW = 6;
export const TITLE_CELL = 'B2';
/** Celle del foglio Costi con i fattori di ricarico. */
export const MATERIAL_MARKUP_CELL = 'AA5';
export const MARKUP_CELL = 'AC5';
export const LEGEND_TEXT = 'Ӿ: Taglio a troncatrice';

/** Colonne del foglio Tempi. */
export const T = {
  pos: 'B', code: 'C', description: 'D', um: 'E', quantity: 'F', productionQuantity: 'G', shape: 'H', material: 'I',
  dimensions: 'J', supplier: 'K', treatments: 'L', cam: 'M', notes: 'AB', weight: 'AC', pricePerKg: 'AD',
  materialCost: 'AE', treatmentsCost: 'AF', otherTimes: 'AG',
} as const;

/** Colonne del foglio Costi. */
export const C = {
  pos: 'B', code: 'C', description: 'D', um: 'E', quantity: 'F', productionQuantity: 'G', treatments: 'H',
  treatmentsCost: 'I', materialCost: 'J', cam: 'K', notes: 'Z', materialWithMarkup: 'AA', workTotal: 'AB',
  unitPrice: 'AC', linePrice: 'AD', otherCosts: 'AE',
} as const;

export interface SlotType { id: number; name: string; excelColumn: string | null; sortOrder?: number }

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();

/**
 * Colonna Excel di ogni tipologia macchina (id tipologia → chiave colonna; assente = "altre lavorazioni").
 */
export function resolveSlots(types: SlotType[]): Map<number, ExcelSlotKey> {
  const out = new Map<number, ExcelSlotKey>();
  const byText = (text: string) => {
    const v = norm(text);
    return EXCEL_SLOTS.find((s) => s.key.toLowerCase() === v || s.names.some((x) => v === x || v.startsWith(`${x} `)));
  };
  const configured = types.some((t) => t.excelColumn && byText(t.excelColumn));
  for (const t of types) {
    const slot = configured ? (t.excelColumn ? byText(t.excelColumn) : undefined) : byText(t.name);
    if (slot) out.set(t.id, slot.key);
  }
  return out;
}

/** Numero da una cella (numero, testo con virgola, risultato di formula); null se vuota o non numerica. */
export function cellNumber(v: unknown): number | null {
  const p = cellPrimitive(v);
  if (p === null || p === '') return null;
  if (typeof p === 'number') return Number.isFinite(p) ? p : null;
  if (p instanceof Date) return null;
  const s = String(p).trim().replace(/\s/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Number(s);
}

/** Testo da una cella (gestisce testo ricco, collegamenti e formule). */
export function cellText(v: unknown): string {
  const p = cellPrimitive(v);
  if (p === null) return '';
  if (p instanceof Date) return p.toISOString().slice(0, 10);
  return String(p).trim();
}

function cellPrimitive(v: unknown): string | number | boolean | Date | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v instanceof Date) return v;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.richText)) return (o.richText as { text: string }[]).map((r) => r.text).join('');
    if ('result' in o) return cellPrimitive(o.result);
    if ('text' in o) return cellPrimitive(o.text);
    if ('error' in o) return null;
  }
  return null;
}

/** Interpreta il titolo in B2: "<cliente> - ORDINE <numero> - Cons. <gg/mm/aaaa> - <testo>". */
export function parseTitle(title: string): { customer: string; number: string; delivery: string | null; errors: string[] } {
  const errors: string[] = [];
  const parts = title.split(' - ').map((p) => p.trim());
  const orderIdx = parts.findIndex((p) => /^ORDINE\b/i.test(p));
  const consIdx = parts.findIndex((p) => /^Cons\./i.test(p));
  if (orderIdx < 1) {
    errors.push(`Titolo in B2 non riconosciuto: atteso "<cliente> - ORDINE <numero> - Cons. <gg/mm/aaaa> - …", trovato "${title}".`);
    return { customer: '', number: '', delivery: null, errors };
  }
  const customer = parts.slice(0, orderIdx).join(' - ').trim();
  const number = parts[orderIdx].replace(/^ORDINE/i, '').replace(/\s+/g, '');
  if (!number) errors.push('Numero del preventivo mancante nel titolo (B2).');
  let delivery: string | null = null;
  if (consIdx > orderIdx) {
    const raw = parts[consIdx].replace(/^Cons\./i, '').trim();
    if (raw) {
      const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(raw);
      if (!m) errors.push(`Data di consegna "${raw}" non valida nel titolo (B2): usare gg/mm/aaaa.`);
      else {
        const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
        const d = new Date(Date.UTC(y, Number(m[2]) - 1, Number(m[1])));
        if (d.getUTCDate() !== Number(m[1]) || d.getUTCMonth() !== Number(m[2]) - 1) errors.push(`Data di consegna "${raw}" non valida nel titolo (B2).`);
        else delivery = d.toISOString().slice(0, 10);
      }
    }
  }
  return { customer, number, delivery, errors };
}

/** Nome file e nomi dei fogli dell'export. */
export function exportNames(number: string, customerName: string) {
  const safeNumber = number.replace(/[\\/?*[\]:]/g, '_');
  const sheet = (suffix: string) => `O.${safeNumber}`.slice(0, 31 - suffix.length) + suffix;
  const customer = customerName.trim().replace(/\s+/g, '_').replace(/[.\\/:*?"<>|]/g, '');
  return { fileName: `O.${safeNumber}_${customer}.xlsx`, timesSheet: sheet('_Tempi'), costsSheet: sheet('_Costi') };
}
