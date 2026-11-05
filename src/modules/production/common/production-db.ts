/**
 * Frammenti SQL e operazioni condivise dall'area produzione (stato effettivo delle lavorazioni,
 * rinumerazione delle code, controllo delle attività registrate su un ordine).
 */
import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { formatInTimeZone } from 'date-fns-tz';
import { map, Observable } from 'rxjs';
import type { EntityManager } from 'typeorm';
import type { AuthUser } from '../../../common/auth/decorators';

/**
 * Stato effettivo di una lavorazione pianificata (alias `si`, ordine `po`), robusto anche se lo stato memorizzato
 * non è stato aggiornato: conclusa se lo è, se l'ordine è completato o se una fase collegata è conclusa;
 * in lavorazione se lo è o se ha fasi collegate; altrimenti aperta (02-produzione §4.3).
 */
export const effectiveStatusSql = (si = 'si', po = 'po') => `(CASE
  WHEN ${si}.status = 'DONE' OR ${po}.status = 'COMPLETED'
    OR EXISTS (SELECT 1 FROM work_phase wpx WHERE wpx.schedule_item_id = ${si}.id AND wpx.deleted_at IS NULL AND wpx.status = 'COMPLETED') THEN 'DONE'
  WHEN ${si}.status = 'IN_PROGRESS'
    OR EXISTS (SELECT 1 FROM work_phase wpx WHERE wpx.schedule_item_id = ${si}.id AND wpx.deleted_at IS NULL) THEN 'IN_PROGRESS'
  ELSE 'OPEN' END)`;
export const EFFECTIVE_STATUS_SQL = effectiveStatusSql();

/** Serializza le modifiche a una coda (stessa macchina o coda di taglio) fino alla fine della transazione. */
export async function lockQueue(em: EntityManager, kind: 'machine' | 'cut', id = 0): Promise<void> {
  await em.query('SELECT pg_advisory_xact_lock($1, $2)', [kind === 'machine' ? 4001 : 4002, id]);
}

/**
 * Rinumera 1..n le lavorazioni non concluse e non eliminate di una macchina, nell'ordine corrente
 * (le lavorazioni in corso restano in testa, come nel calcolo del piano). Le concluse conservano il loro numero.
 */
export async function renumberMachine(em: EntityManager, machineId: number): Promise<void> {
  await em.query(
    `UPDATE schedule_item s SET position = r.rn
       FROM (SELECT si.id, ROW_NUMBER() OVER (ORDER BY (${EFFECTIVE_STATUS_SQL} = 'IN_PROGRESS') DESC, si.position, si.id) AS rn
               FROM schedule_item si JOIN production_order po ON po.id = si.production_order_id
              WHERE si.machine_id = $1 AND si.deleted_at IS NULL AND po.deleted_at IS NULL
                AND ${EFFECTIVE_STATUS_SQL} <> 'DONE') r
      WHERE s.id = r.id AND s.position <> r.rn`,
    [machineId],
  );
}

/** Rinumera 1..n le righe non completate e non eliminate della coda di taglio. */
export async function renumberCutQueue(em: EntityManager): Promise<void> {
  await em.query(
    `UPDATE cut_queue_item c SET position = r.rn
       FROM (SELECT ci.id, ROW_NUMBER() OVER (ORDER BY ci.position, ci.id) AS rn
               FROM cut_queue_item ci JOIN production_order po ON po.id = ci.production_order_id
              WHERE ci.deleted_at IS NULL AND po.deleted_at IS NULL AND ci.status <> 'COMPLETED') r
      WHERE c.id = r.id AND c.position <> r.rn`,
  );
}

export interface OrderActivity {
  phases: number;
  inspections: number;
  cuts: number;
}

/** Attività registrate in reparto su un ordine: fasi, collaudi, tagli iniziati o completati. */
export async function orderActivity(em: EntityManager, orderId: number): Promise<OrderActivity> {
  const [row] = await em.query(
    `SELECT (SELECT COUNT(*) FROM work_phase WHERE production_order_id = $1 AND deleted_at IS NULL)::int AS phases,
            (SELECT COUNT(*) FROM inspection WHERE production_order_id = $1 AND deleted_at IS NULL)::int AS inspections,
            (SELECT COUNT(*) FROM cut_queue_item WHERE production_order_id = $1 AND deleted_at IS NULL AND status <> 'WAITING')::int AS cuts`,
    [orderId],
  );
  return row as OrderActivity;
}

export const describeActivity = (a: OrderActivity): string =>
  [a.phases && `${a.phases} fasi`, a.inspections && `${a.inspections} collaudi`, a.cuts && `${a.cuts} tagli`].filter(Boolean).join(', ');

export const hasActivity = (a: OrderActivity) => a.phases + a.inspections + a.cuts > 0;

/** Data di oggi nel fuso dell'officina ('YYYY-MM-DD'). */
export const todayIn = (timeZone: string): string => formatInTimeZone(new Date(), timeZone, 'yyyy-MM-dd');

/** Prezzi di materiali e macchine: le pagine di produzione non li usano e non vanno mai restituiti all'ufficio. */
const RESERVED_KEYS = new Set(['pricePerKg', 'hourlyRate', 'materialPricePerKg', 'machineHourlyRate']);

function strip(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== 'object' || value instanceof Date || Buffer.isBuffer(value)) return value;
  if (seen.has(value as object)) return value;
  seen.add(value as object);
  if (Array.isArray(value)) value.forEach((v) => strip(v, seen));
  else for (const key of Object.keys(value as Record<string, unknown>)) {
    if (RESERVED_KEYS.has(key)) delete (value as Record<string, unknown>)[key];
    else strip((value as Record<string, unknown>)[key], seen);
  }
  return value;
}

/** Toglie i prezzi riservati dalle risposte per chi non è amministratore (docs/architettura.md, "Prezzi riservati"). */
@Injectable()
export class ProductionStripPricesInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const user: AuthUser | undefined = context.switchToHttp().getRequest().user;
    if (user?.role === 'ADMIN') return next.handle();
    return next.handle().pipe(map((data) => strip(data)));
  }
}

/**
 * Ricostruisce `filter` dalla query string grezza: con Express 5 il parser predefinito non trasforma
 * `filter[campo]=valore` in oggetto e la validazione scarterebbe le chiavi. Funziona con entrambi i parser.
 */
export function withRawFilters<Q extends { filter?: Record<string, string> }>(q: Q, raw: Record<string, unknown> | undefined): Q {
  const filter: Record<string, string> = { ...(q.filter ?? {}) };
  for (const [key, value] of Object.entries(raw ?? {})) {
    const m = key.match(/^filter\[([A-Za-z0-9_.]+)\]$/);
    if (m && value !== undefined) filter[m[1]] = String(Array.isArray(value) ? value[0] : value);
  }
  if (raw?.filter && typeof raw.filter === 'object') {
    for (const [k, v] of Object.entries(raw.filter as Record<string, unknown>)) if (v !== undefined) filter[k] = String(v);
  }
  return { ...q, filter };
}
