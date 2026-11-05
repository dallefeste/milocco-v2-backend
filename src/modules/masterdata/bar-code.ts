/**
 * Codice articolo delle barre (materie prime):
 * `MP` + codice materiale + forma (2 lettere) + codice finitura (1 carattere) + dimensioni.
 * Esempio: MPFE01PIT100X10 = materiale FE01, piatto (PI), trafilato (T), 100X10.
 */
export const BAR_CODE_PREFIX = 'MP';

export const normalizeDimensions = (dims: string | null | undefined) => (dims ?? '').replace(/\s+/g, '').toUpperCase();

export function buildBarCode(materialCode: string, shape: string, finishCode: string, dimensions: string): string {
  return `${BAR_CODE_PREFIX}${materialCode}${shape}${finishCode}${normalizeDimensions(dimensions)}`.toUpperCase();
}
