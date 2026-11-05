/**
 * Calcolatore peso dei particolari (specifica 02-produzione §2.4).
 * peso [kg] = volume [mm³] × densità [g/cm³] / 1.000.000, arrotondato a 3 decimali.
 * Il testo dimensioni ha il formato "<Forma> - <param><valore> … L<lunghezza>" (es. "Barra circolare - d50 L43").
 */
export interface ShapeParamDef {
  key: string;
  label: string;
  /** Facoltativo (solo forma Custom: basta L). */
  optional?: boolean;
}

export interface ShapeDef {
  key: string;
  label: string;
  params: ShapeParamDef[];
  /** Volume in mm³; null = forma senza calcolo (Custom). */
  volume: ((p: Record<string, number>) => number) | null;
  /** Controlli di coerenza delle misure: ritorna un messaggio d'errore o null. */
  check?: (p: Record<string, number>) => string | null;
}

const L: ShapeParamDef = { key: 'L', label: 'Lunghezza' };

export const WEIGHT_SHAPES: ShapeDef[] = [
  { key: 'SHEET', label: 'Foglio/Lamiera', params: [{ key: 't', label: 'Spessore' }, { key: 'w', label: 'Larghezza' }, L], volume: (p) => p.t * p.w * p.L },
  { key: 'ROUND_BAR', label: 'Barra circolare', params: [{ key: 'd', label: 'Diametro' }, L], volume: (p) => (Math.PI * p.d * p.d * p.L) / 4 },
  { key: 'FLAT_BAR', label: 'Barra piatta', params: [{ key: 'a', label: 'Larghezza' }, { key: 'b', label: 'Spessore' }, L], volume: (p) => p.a * p.b * p.L },
  { key: 'SQUARE_BAR', label: 'Barra quadrata', params: [{ key: 'a', label: 'Lato' }, L], volume: (p) => p.a * p.a * p.L },
  { key: 'HEX_BAR', label: 'Barra esagonale', params: [{ key: 'a', label: 'Chiave (distanza tra i lati)' }, L], volume: (p) => (p.a * p.a * Math.sqrt(3) * p.L) / 2 },
  {
    key: 'TUBE_ID', label: 'Tubo (diametro interno)',
    params: [{ key: 'd', label: 'Diametro interno' }, { key: 't', label: 'Spessore' }, L],
    volume: (p) => Math.PI * p.t * (p.t + p.d) * p.L,
  },
  {
    key: 'TUBE_OD', label: 'Tubo (diametro esterno)',
    params: [{ key: 'd', label: 'Diametro esterno' }, { key: 't', label: 'Spessore' }, L],
    volume: (p) => Math.PI * p.t * (p.d - p.t) * p.L,
    check: (p) => (2 * p.t >= p.d ? 'Lo spessore deve essere minore della metà del diametro esterno.' : null),
  },
  {
    key: 'RECT_TUBE', label: 'Tubo rettangolare',
    params: [{ key: 'h', label: 'Altezza' }, { key: 'w', label: 'Larghezza' }, { key: 't', label: 'Spessore' }, L],
    volume: (p) => 2 * p.t * (p.h + p.w - 2 * p.t) * p.L,
    check: (p) => (2 * p.t >= Math.min(p.h, p.w) ? "Lo spessore deve essere minore della metà del lato più corto." : null),
  },
  {
    key: 'U_PROFILE', label: 'Profilo a U',
    params: [{ key: 'h', label: 'Altezza ali' }, { key: 'w', label: 'Larghezza' }, { key: 't', label: 'Spessore' }, L],
    volume: (p) => p.t * (2 * p.h + p.w - 2 * p.t) * p.L,
    check: (p) => (2 * p.t >= p.w || p.t >= p.h ? 'Lo spessore non è compatibile con altezza e larghezza.' : null),
  },
  {
    key: 'SQUARE_TUBE', label: 'Tubo quadrato',
    params: [{ key: 'h', label: 'Lato' }, { key: 't', label: 'Spessore' }, L],
    volume: (p) => 4 * p.t * (p.h - p.t) * p.L,
    check: (p) => (2 * p.t >= p.h ? 'Lo spessore deve essere minore della metà del lato.' : null),
  },
  {
    key: 'ANGLE', label: 'Angolare',
    params: [{ key: 'L1', label: 'Lato 1' }, { key: 'L2', label: 'Lato 2' }, { key: 't', label: 'Spessore' }, L],
    volume: (p) => p.t * (p.L1 + p.L2 - p.t) * p.L,
    check: (p) => (p.t >= Math.min(p.L1, p.L2) ? 'Lo spessore deve essere minore dei lati.' : null),
  },
  {
    key: 'CUSTOM', label: 'Custom',
    params: [{ key: 'a', label: 'a', optional: true }, { key: 'b', label: 'b', optional: true }, { key: 'c', label: 'c', optional: true }, { key: 'd', label: 'd', optional: true }, L],
    volume: null,
  },
];

export const findShape = (key: string | null | undefined): ShapeDef | undefined => WEIGHT_SHAPES.find((s) => s.key === key);

/** Numero nel testo dimensioni: al massimo 2 decimali, virgola decimale, senza zeri inutili. */
const fmt = (v: number) => String(Math.round(v * 100) / 100).replace('.', ',');

export interface WeightResult {
  shape: string;
  shapeLabel: string;
  /** Misure normalizzate (solo quelle della forma, in mm). */
  params: Record<string, number>;
  volumeMm3: number | null;
  density: number | null;
  /** null se la forma non ha un calcolo (Custom) o il materiale non ha densità. */
  weightKg: number | null;
  dimensions: string;
  cutLengthMm: number;
  /** Avviso per l'utente (es. densità mancante). */
  warning: string | null;
}

/** Errore di validazione delle misure, con messaggio per l'utente. */
export class WeightInputError extends Error {}

/** Calcola volume, peso e testo dimensioni. Lancia WeightInputError se le misure non sono valide. */
export function computeWeight(shapeKey: string, rawParams: Record<string, unknown>, density: number | null | undefined): WeightResult {
  const shape = findShape(shapeKey);
  if (!shape) throw new WeightInputError(`Forma sconosciuta: ${shapeKey}`);
  const params: Record<string, number> = {};
  for (const def of shape.params) {
    const raw = rawParams?.[def.key];
    const empty = raw === null || raw === undefined || raw === '';
    if (empty) {
      if (def.optional) continue;
      throw new WeightInputError(`Manca la misura "${def.label}" (${def.key}).`);
    }
    const v = Number(String(raw).replace(',', '.'));
    if (!Number.isFinite(v) || v <= 0) throw new WeightInputError(`La misura "${def.label}" (${def.key}) deve essere un numero maggiore di zero.`);
    params[def.key] = v;
  }
  const problem = shape.check?.(params);
  if (problem) throw new WeightInputError(problem);

  const text = shape.params.filter((d) => params[d.key] !== undefined).map((d) => `${d.key}${fmt(params[d.key])}`).join(' ');
  const dimensions = `${shape.label} - ${text}`;
  const volume = shape.volume ? shape.volume(params) : null;
  let weightKg: number | null = null;
  let warning: string | null = null;
  const dens = density && density > 0 ? density : null;
  if (volume === null) warning = 'Forma Custom: il peso non si calcola, va inserito a mano.';
  else if (!dens) warning = 'Il materiale non ha la densità: il peso non si può calcolare (imposta la densità in Anagrafiche → Materiali).';
  else weightKg = Math.round(((volume * dens) / 1_000_000) * 1000) / 1000;

  return {
    shape: shape.key,
    shapeLabel: shape.label,
    params,
    volumeMm3: volume === null ? null : Math.round(volume * 100) / 100,
    density: dens,
    weightKg,
    dimensions,
    cutLengthMm: params.L,
    warning,
  };
}
