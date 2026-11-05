/**
 * Funzioni comuni dell'import: conversione di date, ore e durate, inserimento a blocchi, conteggi.
 */
import { fromZonedTime } from 'date-fns-tz';
import type { PoolClient } from 'pg';
import * as iconv from 'iconv-lite';

/** Fuso orario in cui il vecchio sistema salvava date e ore (ora locale dello stabilimento). */
export const LEGACY_TZ = 'Europe/Rome';

/** Istante di inizio dell'import: usato come data di eliminazione delle righe cancellate. */
export const IMPORT_NOW = new Date();

/**
 * Data-ora MySQL ("YYYY-MM-DD HH:MM:SS", ora locale italiana) → Date (istante assoluto).
 * Valori vuoti o "zero" (0000-00-00) → null.
 */
export function legacyDateTime(v: unknown): Date | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s || s.startsWith('0000-00-00')) return null;
  const d = fromZonedTime(s.replace(' ', 'T'), LEGACY_TZ);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Data MySQL ("YYYY-MM-DD") → stringa per una colonna date; vuota, zero o non plausibile → null.
 * Nel vecchio database ci sono date di consegna come 1901/1902 (valori di default sbagliati):
 * una data prima del 1990 non ha senso per questo stabilimento e viene scartata.
 */
export function legacyDate(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number(s.slice(0, 4)) < 1990) return null;
  return s;
}

/**
 * Durata TIME MySQL ("HH:MM:SS", anche oltre 24 ore o negativa) → secondi interi.
 * Restituisce null se il valore manca o non è leggibile.
 */
export function timeToSeconds(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const m = /^(-)?(\d+):(\d{1,2}):(\d{1,2})(?:\.\d+)?$/.exec(String(v).trim());
  if (!m) return null;
  const secs = parseInt(m[2], 10) * 3600 + parseInt(m[3], 10) * 60 + parseInt(m[4], 10);
  return m[1] ? -secs : secs;
}

/** Valore 0/1 (o null) del vecchio DB → boolean. */
export const bool = (v: unknown): boolean => v !== null && v !== undefined && Number(v) !== 0;

/** Testo ripulito; vuoto → null. */
export function text(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
}

/** Numero (anche float MySQL) arrotondato a `decimals` cifre; non numerico → null. */
export function num(v: unknown, decimals = 4): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

/** Data di eliminazione logica per una riga con deleted = 1. */
export const deletedAt = (deleted: unknown): Date | null => (bool(deleted) ? IMPORT_NOW : null);

// -------------------------------------------------------------------------------------------------
// Conteggi per il riepilogo finale
// -------------------------------------------------------------------------------------------------

export interface TableStats {
  read: number;
  imported: number;
  /** Righe scartate, per motivo. */
  skipped: Map<string, number>;
  /** Correzioni fatte senza scartare la riga (valore messo a null, stimato, ricostruito...), per motivo. */
  fixed: Map<string, number>;
}

export class Stats {
  readonly tables = new Map<string, TableStats>();

  private get(table: string): TableStats {
    let t = this.tables.get(table);
    if (!t) {
      t = { read: 0, imported: 0, skipped: new Map(), fixed: new Map() };
      this.tables.set(table, t);
    }
    return t;
  }

  read(table: string, n = 1) { this.get(table).read += n; }
  imported(table: string, n = 1) { this.get(table).imported += n; }
  skip(table: string, reason: string, n = 1) {
    const m = this.get(table).skipped;
    m.set(reason, (m.get(reason) ?? 0) + n);
  }
  fix(table: string, reason: string, n = 1) {
    const m = this.get(table).fixed;
    m.set(reason, (m.get(reason) ?? 0) + n);
  }

  /** Testo del riepilogo: per tabella righe lette, importate, scartate (con motivo) e correzioni. */
  report(): string {
    const lines: string[] = [];
    const pad = (s: string | number, n: number) => String(s).padStart(n);
    lines.push(`${'Vecchia tabella → nuova tabella'.padEnd(58)} ${pad('lette', 7)} ${pad('importate', 10)} ${pad('scartate', 9)}`);
    lines.push('-'.repeat(87));
    for (const [name, t] of this.tables) {
      const skipped = [...t.skipped.values()].reduce((a, b) => a + b, 0);
      lines.push(`${name.padEnd(58)} ${pad(t.read, 7)} ${pad(t.imported, 10)} ${pad(skipped, 9)}`);
      for (const [reason, n] of t.skipped) lines.push(`    scartate ${pad(n, 6)}  ${reason}`);
      for (const [reason, n] of t.fixed) lines.push(`    corrette ${pad(n, 6)}  ${reason}`);
    }
    return lines.join('\n');
  }
}

// -------------------------------------------------------------------------------------------------
// Inserimento a blocchi
// -------------------------------------------------------------------------------------------------

export type Row = Record<string, unknown>;

/** Valore pronto per pg: gli oggetti (non Date) diventano JSON per le colonne jsonb. */
function pgValue(v: unknown): unknown {
  if (v === undefined) return null;
  if (v !== null && typeof v === 'object' && !(v instanceof Date)) return JSON.stringify(v);
  return v;
}

/**
 * Inserisce le righe in blocchi con INSERT multi-riga. Le colonne sono quelle della prima riga
 * (tutte le righe devono avere le stesse chiavi). Restituisce il numero di righe inserite.
 */
export async function insertRows(db: PoolClient, table: string, rows: Row[]): Promise<number> {
  if (rows.length === 0) return 0;
  const cols = Object.keys(rows[0]);
  const perBatch = Math.max(1, Math.floor(60000 / cols.length));
  let inserted = 0;
  for (let i = 0; i < rows.length; i += perBatch) {
    const chunk = rows.slice(i, i + perBatch);
    const params: unknown[] = [];
    const tuples = chunk.map((r) => {
      const ph = cols.map((c) => {
        params.push(pgValue(r[c]));
        return `$${params.length}`;
      });
      return `(${ph.join(',')})`;
    });
    const res = await db.query(`INSERT INTO ${table} (${cols.join(',')}) VALUES ${tuples.join(',')}`, params);
    inserted += res.rowCount ?? chunk.length;
  }
  return inserted;
}

/** Raggruppa un array per chiave. */
export function groupBy<T, K>(items: T[], key: (t: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const it of items) {
    const k = key(it);
    const arr = m.get(k);
    if (arr) arr.push(it);
    else m.set(k, [it]);
  }
  return m;
}

/** Massimo tra date (ignora i null). */
export function maxDate(...ds: (Date | null | undefined)[]): Date | null {
  let r: Date | null = null;
  for (const d of ds) if (d && (!r || d > r)) r = d;
  return r;
}

/** Minimo tra date (ignora i null). */
export function minDate(...ds: (Date | null | undefined)[]): Date | null {
  let r: Date | null = null;
  for (const d of ds) if (d && (!r || d < r)) r = d;
  return r;
}

/**
 * Alcuni testi del vecchio database sono stati salvati due volte in codifica (UTF-8 letto come
 * Windows-1252 e risalvato): "Ø" compare come "Ã˜", "à" come "Ã ". Se la stringa ha questo aspetto e
 * la conversione inversa è senza perdite, restituisce il testo corretto; altrimenti la lascia com'è.
 */
export function fixMojibake(s: string): string {
  // Caso in cui il secondo carattere della coppia è andato perso: "Ã60" era "Ø60" (diametro).
  s = s.replace(/Ã(?=\d)/g, 'Ø');
  if (!/[ÃÂâ][\u0080-\u02FF\u2000-\u203A\u20AC\u2122]/.test(s)) return s;
  // Ricostruisce i byte originali: i caratteri fino a U+00FF valgono come byte (Latin-1, anche i
  // controlli U+0080–U+009F), gli altri (€, ˜, ’...) secondo Windows-1252.
  const bytes: number[] = [];
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c <= 0xff) { bytes.push(c); continue; }
    const enc = iconv.encode(ch, 'win1252');
    if (enc.length !== 1 || iconv.decode(enc, 'win1252') !== ch) return s;
    bytes.push(enc[0]!);
  }
  const fixed = Buffer.from(bytes).toString('utf8');
  return fixed.includes('\uFFFD') ? s : fixed;
}

/** Applica fixMojibake a tutti i campi testo di una riga letta dal vecchio database. */
export function fixRowText<T extends Record<string, unknown>>(row: T): T {
  for (const k of Object.keys(row)) {
    const v = row[k];
    if (typeof v === 'string') (row as Record<string, unknown>)[k] = fixMojibake(v);
  }
  return row;
}
