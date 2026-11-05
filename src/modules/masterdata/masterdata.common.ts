import { CallHandler, ConflictException, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Transform } from 'class-transformer';
import type { EntityManager } from 'typeorm';
import { map, Observable } from 'rxjs';
import type { UserRole } from '../../shared';

/** Campi con prezzi riservati all'amministratore (materiali, macchine, tariffe macchina per cliente). */
export const RESERVED_PRICE_KEYS = ['pricePerKg', 'hourlyRate', 'customerRates'] as const;

/** Copia di un valore senza i campi prezzo riservati, a qualunque profondità (oggetti annidati e liste). */
export function stripReservedPrices<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => stripReservedPrices(v)) as unknown as T;
  if (value === null || typeof value !== 'object' || value instanceof Date || Buffer.isBuffer(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if ((RESERVED_PRICE_KEYS as readonly string[]).includes(k)) continue;
    out[k] = stripReservedPrices(v);
  }
  return out as T;
}

export const canSeePrices = (role: UserRole | undefined) => role === 'ADMIN';

/**
 * Toglie i prezzi riservati dalle risposte per chi non è amministratore.
 * Utilizzabile anche dagli altri moduli: `@UseInterceptors(ReservedPricesInterceptor)`.
 */
@Injectable()
export class ReservedPricesInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const role = context.switchToHttp().getRequest().user?.role as UserRole | undefined;
    if (canSeePrices(role)) return next.handle();
    return next.handle().pipe(map((data) => stripReservedPrices(data)));
  }
}

/** Toglie gli spazi all'inizio e alla fine dei testi ricevuti. */
export const Trim = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));
/** Testo in maiuscolo e senza spazi esterni (codici). */
export const UpperTrim = () => Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value));
/** Testo vuoto → null. */
export const EmptyToNull = () => Transform(({ value }) => (typeof value === 'string' && value.trim() === '' ? null : value));

export interface UsageCheck {
  sql: string;
  params: unknown[];
  /** Messaggio quando il conteggio è maggiore di zero. */
  message: (count: number) => string;
}

/** Controlla che un elemento non sia usato da altri dati; altrimenti errore 409 con messaggio chiaro. */
export async function assertNotUsed(manager: EntityManager, checks: UsageCheck[]): Promise<void> {
  for (const c of checks) {
    const rows: { n: string | number }[] = await manager.query(`SELECT count(*) AS n FROM (${c.sql}) AS used`, c.params);
    const n = Number(rows[0]?.n ?? 0);
    if (n > 0) throw new ConflictException(c.message(n));
  }
}

/** "1 ordine" / "3 ordini". */
export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
