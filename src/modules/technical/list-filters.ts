import type { ListQueryDto } from '../../common/crud/list-query.dto';

/**
 * Ricostruisce `filter` dalla query string grezza. Con Express 5 il parser predefinito ("simple")
 * non trasforma `filter[campo]=valore` in oggetto e la validazione scarta le chiavi: qui si leggono
 * entrambe le forme, così i filtri funzionano con qualunque configurazione del parser.
 */
export function withRawFilters(q: ListQueryDto, raw: Record<string, unknown> | undefined): ListQueryDto {
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
