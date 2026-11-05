import * as E from './index';

/** Tutte le entità, da registrare una volta sola in TypeORM. */
export const ALL_ENTITIES = Object.values(E).filter((v) => typeof v === 'function');
