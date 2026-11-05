-- Rimozione dell'integrazione con il gestionale Onda (2026-11-05): il cliente non usa più Onda.
-- Ordini cliente e giacenze barre si gestiscono solo in questo gestionale (vedi docs/decisioni.md).

DROP INDEX IF EXISTS customer_onda_uq;
DROP INDEX IF EXISTS customer_onda_idx;
DROP INDEX IF EXISTS customer_order_onda_uq;
DROP INDEX IF EXISTS customer_order_onda_doc_idx;

ALTER TABLE customer DROP COLUMN IF EXISTS onda_anagrafica_id;
ALTER TABLE customer_order DROP COLUMN IF EXISTS onda_doc_id;
ALTER TABLE bar_stock
  DROP COLUMN IF EXISTS onda_doc_id,
  DROP COLUMN IF EXISTS onda_row_id,
  DROP COLUMN IF EXISTS onda_pending,
  -- data dell'ultimo allineamento con Onda: senza Onda non ha più significato
  DROP COLUMN IF EXISTS synced_at;

DELETE FROM app_setting WHERE key = 'onda_last_bar_row';
