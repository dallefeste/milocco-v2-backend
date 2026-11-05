import { BadRequestException } from '@nestjs/common';
import { addDays, differenceInCalendarDays, format, parseISO, subDays } from 'date-fns';
import { formatInTimeZone, fromZonedTime, toZonedTime } from 'date-fns-tz';

/** Fuso orario dello stabilimento (date dei report e confini dei giorni). */
export const TZ = process.env.APP_TIMEZONE ?? 'Europe/Rome';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Giorno di oggi (AAAA-MM-GG) nel fuso dello stabilimento. */
export const todayLocal = (now = new Date()): string => formatInTimeZone(now, TZ, 'yyyy-MM-dd');

/** Controlla una data AAAA-MM-GG; se assente usa il valore predefinito. */
export function parseDay(value: string | undefined, fallback: string, label = 'data'): string {
  if (!value) return fallback;
  if (!DAY_RE.test(value) || Number.isNaN(parseISO(value).getTime())) {
    throw new BadRequestException(`La ${label} non è valida: usa il formato AAAA-MM-GG.`);
  }
  return value;
}

/** Istanti di inizio (incluso) e fine (escluso) di un giorno locale. */
export function dayBounds(day: string): { start: Date; end: Date } {
  const start = fromZonedTime(`${day}T00:00:00`, TZ);
  const next = format(addDays(parseISO(day), 1), 'yyyy-MM-dd');
  return { start, end: fromZonedTime(`${next}T00:00:00`, TZ) };
}

/** Istante locale "giorno + ora" (es. 2019-11-05 + '08:00:00'). */
export const localTime = (day: string, hhmmss: string): Date => fromZonedTime(`${day}T${hhmmss.length === 5 ? `${hhmmss}:00` : hhmmss}`, TZ);

/**
 * Intervallo di date dai parametri from/to (inclusi). Predefinito: ultimi 7 giorni.
 * @param maxDays numero massimo di giorni ammessi (inclusi gli estremi).
 */
export function dateRange(from?: string, to?: string, maxDays?: number): { from: string; to: string; start: Date; end: Date; days: number } {
  const today = todayLocal();
  const t = parseDay(to, today, 'data di fine');
  const f = parseDay(from, format(subDays(parseISO(t), 7), 'yyyy-MM-dd'), 'data di inizio');
  const days = differenceInCalendarDays(parseISO(t), parseISO(f)) + 1;
  if (days < 1) throw new BadRequestException("L'intervallo di date non è valido: la data di inizio è dopo la data di fine.");
  if (maxDays && days > maxDays) throw new BadRequestException(`L'intervallo di date non è valido: al massimo ${maxDays} giorni.`);
  return { from: f, to: t, start: dayBounds(f).start, end: dayBounds(t).end, days };
}

/** Giorno locale (AAAA-MM-GG) di un istante. */
export const localDay = (d: Date | string): string => formatInTimeZone(typeof d === 'string' ? new Date(d) : d, TZ, 'yyyy-MM-dd');

/** Data e ora locale leggibile per le stampe. */
export const fmtLocal = (d: Date | string | null | undefined, pattern = 'dd/MM/yyyy HH:mm'): string =>
  d ? formatInTimeZone(typeof d === 'string' ? new Date(d) : d, TZ, pattern) : '';

/** Giorno della settimana locale: 0 = lunedì … 6 = domenica (come work_calendar_day). */
export const localWeekday = (day: string): number => (toZonedTime(dayBounds(day).start, TZ).getDay() + 6) % 7;

/** Nome e cognome. */
export const personName = (first?: string | null, last?: string | null): string => [first, last].filter(Boolean).join(' ').trim();

/** Codice disegno con revisione. */
export const drawingLabel = (code?: string | null, revision?: string | null): string => (code ? (revision ? `${code}.${revision}` : code) : '');
