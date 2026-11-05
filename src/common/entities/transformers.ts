import { ValueTransformer } from 'typeorm';

/** PostgreSQL restituisce numeric come stringa: lo convertiamo in number. */
export const numeric: ValueTransformer = {
  to: (v: number | null | undefined) => v,
  from: (v: string | null) => (v === null || v === undefined ? null : Number(v)),
};
