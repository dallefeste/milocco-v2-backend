/**
 * Lettura del testo "dimensioni" dei particolari del vecchio sistema.
 *
 * Formato scritto dal calcolatore peso: "<Forma> - <param><valore> … L<lunghezza>",
 * es. "Barra circolare - d50 L43", "Tubo (diametro esterno) - d60.3 t5.54 L905".
 * Per l'Angolare i lati sono scritti come "L1" + valore e "L2" + valore, quindi
 * "Angolare - L115 L210 t1.5 L74" = L1 15, L2 10, t 1,5, L 74: la lunghezza è l'ultimo "L".
 * I testi liberi ("A Disegno", "VARIE", "D.80 x 45"...) non sono interpretabili: forma e misure restano vuote.
 */
import { WEIGHT_SHAPES } from '../../../src/modules/technical/weight-calculator';

export interface ParsedDimensions {
  shape: string;
  params: Record<string, number>;
  cutLengthMm: number | null;
}

const NUMBER = '(\\d+(?:[.,]\\d+)?)';
const byLabel = new Map(WEIGHT_SHAPES.map((s) => [s.label.toLowerCase(), s]));

const toNum = (s: string) => Number(s.replace(',', '.'));

export function parseDimensions(raw: string | null | undefined): ParsedDimensions | null {
  if (!raw) return null;
  const sep = raw.indexOf(' - ');
  if (sep < 0) return null;
  const shape = byLabel.get(raw.slice(0, sep).trim().toLowerCase());
  if (!shape) return null;
  const tokens = raw.slice(sep + 3).trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  const allowed = new Set(shape.params.map((p) => p.key));
  const params: Record<string, number> = {};

  if (shape.key === 'ANGLE') {
    // Ordine atteso: L1<v> L2<v> t<v> L<v>
    const m = new RegExp(`^L1${NUMBER}\\s+L2${NUMBER}\\s+t${NUMBER}\\s+L${NUMBER}$`).exec(tokens.join(' '));
    if (!m) return null;
    params.L1 = toNum(m[1]);
    params.L2 = toNum(m[2]);
    params.t = toNum(m[3]);
    params.L = toNum(m[4]);
  } else {
    for (const tok of tokens) {
      const m = new RegExp(`^([A-Za-z])${NUMBER}$`).exec(tok);
      if (!m || !allowed.has(m[1]) || params[m[1]] !== undefined) return null;
      params[m[1]] = toNum(m[2]);
    }
    // Tutte le misure obbligatorie della forma devono esserci
    for (const p of shape.params) if (!p.optional && params[p.key] === undefined) return null;
  }
  if (Object.values(params).some((v) => !Number.isFinite(v))) return null;
  return { shape: shape.key, params, cutLengthMm: params.L ?? null };
}
