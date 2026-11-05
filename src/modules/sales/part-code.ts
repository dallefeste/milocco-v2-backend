/**
 * Codice e revisione dei disegni e dei particolari: codice interno del particolare creato insieme al disegno
 * e lettura di codice/revisione dalle righe dell'Excel dei preventivi.
 * La revisione è portata in minuscolo (come i disegni esistenti); senza revisione indicata vale "00".
 */
export const DEFAULT_REVISION = '00';

/** Codice interno del particolare creato insieme al disegno: "<codice>.<revisione>". */
export const partInternalCode = (code: string, revision: string) => `${code}.${revision || DEFAULT_REVISION}`;

/**
 * Revisione esplicita nella descrizione di una riga Excel (ultima parola "Rev.XX", "RevXX" o "RXX",
 * esattamente 2 caratteri alfanumerici). Restituisce anche la descrizione senza quella parola.
 * Correzione dell'anomalia 01-commerciale §1.7: "VITE M8" non è più letto come revisione "M8".
 */
export function revisionFromDescription(description: string | null | undefined): { revision: string | null; name: string } {
  const text = (description ?? '').trim();
  const words = text.split(/\s+/).filter(Boolean);
  const last = words[words.length - 1] ?? '';
  const m = /^(?:REV\.?\s*|R)([0-9A-Z]{2})$/i.exec(last);
  if (!m) return { revision: null, name: text };
  return { revision: m[1].toLowerCase(), name: words.slice(0, -1).join(' ') };
}

/**
 * Codice della colonna C dell'Excel: accetta "CODICE" oppure "CODICE.REV" (come scritto dall'export,
 * revisione di 1-2 caratteri dopo l'ultimo punto).
 */
export function splitExcelCode(raw: string | null | undefined): { code: string; revision: string | null } {
  const text = (raw ?? '').trim();
  const m = /^(.+)\.([0-9A-Za-z]{1,2})$/.exec(text);
  if (m) return { code: m[1], revision: m[2].toLowerCase() };
  return { code: text, revision: null };
}
