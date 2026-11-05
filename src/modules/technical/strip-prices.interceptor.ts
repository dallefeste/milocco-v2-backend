import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { map, Observable } from 'rxjs';
import type { AuthUser } from '../../common/auth/decorators';

/** Campi con prezzi riservati all'amministratore (materiali e macchine). */
const RESERVED_KEYS = new Set(['pricePerKg', 'hourlyRate', 'materialPricePerKg', 'machineHourlyRate']);

function strip(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date || Buffer.isBuffer(value)) return value;
  if (seen.has(value as object)) return value;
  seen.add(value as object);
  if (Array.isArray(value)) {
    for (const item of value) strip(item, seen);
    return value;
  }
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (RESERVED_KEYS.has(key)) delete (value as Record<string, unknown>)[key];
    else strip((value as Record<string, unknown>)[key], seen);
  }
  return value;
}

/**
 * Toglie dalle risposte i prezzi di materiali e macchine per gli utenti non amministratori
 * (regola "Prezzi riservati" di docs/architettura.md: non basta nasconderli nel frontend).
 */
@Injectable()
export class StripPricesInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const user: AuthUser | undefined = context.switchToHttp().getRequest().user;
    if (user?.role === 'ADMIN') return next.handle();
    return next.handle().pipe(map((data) => strip(data)));
  }
}
