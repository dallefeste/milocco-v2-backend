/**
 * Stato calcolato "Da compilare" / "Compilato" di disegni e particolari (COMPLETENESS_STATUSES).
 * - Particolare da compilare: nessuna fase nel ciclo di lavorazione.
 * - Disegno da compilare: senza particolari oppure con ALMENO UN particolare senza fasi
 *   (correzione dell'anomalia del sistema precedente, dove bastava una fase su un particolare).
 * Le espressioni sono SQL da usare nelle query builder con l'alias della tabella principale.
 */
export const partToCompleteSql = (alias: string) =>
  `NOT EXISTS (SELECT 1 FROM part_cycle_step pcs_c WHERE pcs_c.part_id = ${alias}.id)`;

export const drawingToCompleteSql = (alias: string) =>
  `(NOT EXISTS (SELECT 1 FROM drawing_part dp_c WHERE dp_c.drawing_id = ${alias}.id)` +
  ` OR EXISTS (SELECT 1 FROM drawing_part dp_c WHERE dp_c.drawing_id = ${alias}.id` +
  ` AND NOT EXISTS (SELECT 1 FROM part_cycle_step pcs_c WHERE pcs_c.part_id = dp_c.part_id)))`;
