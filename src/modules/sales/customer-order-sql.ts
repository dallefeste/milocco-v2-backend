/**
 * Frammenti SQL dello stato calcolato dell'ordine cliente (01-commerciale §2.2, con la regola corretta
 * del disegno "da compilare": senza particolari o con almeno un particolare senza ciclo).
 */

/** Condizione "disegno da compilare" per l'espressione SQL del suo id. */
export const drawingIncompleteSql = (drawingIdExpr: string) => `(
  NOT EXISTS (SELECT 1 FROM drawing_part dpx JOIN part px ON px.id = dpx.part_id AND px.deleted_at IS NULL WHERE dpx.drawing_id = ${drawingIdExpr})
  OR EXISTS (
    SELECT 1 FROM drawing_part dpx JOIN part px ON px.id = dpx.part_id AND px.deleted_at IS NULL
     WHERE dpx.drawing_id = ${drawingIdExpr}
       AND NOT EXISTS (SELECT 1 FROM part_cycle_step sx WHERE sx.part_id = px.id)
  )
)`;

/**
 * Sottoquery con una riga per ordine cliente non eliminato e i dati calcolati
 * (aggregati raggruppati: ~80 ms su 21.000 ordini, contro ~600 ms con sottoquery per riga).
 * Un disegno da compilare rende l'ordine "INCOMPLETE" solo se la sua riga è ancora da confermare
 * (vedi docs/decisioni.md). Termina con "WHERE co.deleted_at IS NULL": si possono aggiungere condizioni con AND.
 */
export const customerOrderStatsSql = `
  WITH inc AS (
    SELECT d.id FROM drawing d
     WHERE d.id IN (SELECT drawing_id FROM customer_order_line WHERE status = 'PENDING' AND deleted_at IS NULL)
       AND ${drawingIncompleteSql('d.id')}
  ), s AS (
    SELECT l.customer_order_id,
           count(*)::int AS lines_count,
           (count(*) FILTER (WHERE l.status = 'PENDING'))::int AS pending_count,
           (count(*) FILTER (WHERE l.status = 'PENDING' AND l.drawing_id IN (SELECT id FROM inc)))::int AS incomplete_count
      FROM customer_order_line l
     WHERE l.deleted_at IS NULL
     GROUP BY l.customer_order_id
  ), po AS (
    SELECT p.customer_order_id,
           count(*)::int AS po_count,
           CASE WHEN count(*) = count(*) FILTER (WHERE p.status = 'COMPLETED') THEN max(p.completed_at) END AS completion_date
      FROM production_order p
     WHERE p.deleted_at IS NULL
     GROUP BY p.customer_order_id
  )
  SELECT co.id,
         COALESCE(s.lines_count, 0) AS lines_count,
         COALESCE(s.pending_count, 0) AS pending_count,
         COALESCE(s.incomplete_count, 0) AS incomplete_count,
         COALESCE(s.lines_count, 0) - COALESCE(s.pending_count, 0) AS confirmed_count,
         COALESCE(po.po_count, 0) AS po_count,
         po.completion_date,
         CASE WHEN COALESCE(s.lines_count, 0) = 0 OR s.incomplete_count > 0 THEN 'INCOMPLETE'
              WHEN s.pending_count = 0 THEN 'CONFIRMED'
              WHEN s.pending_count = s.lines_count THEN 'TO_CONFIRM'
              ELSE 'PARTIALLY_CONFIRMED' END AS status
    FROM customer_order co
    LEFT JOIN s ON s.customer_order_id = co.id
    LEFT JOIN po ON po.customer_order_id = co.id
   WHERE co.deleted_at IS NULL`;
