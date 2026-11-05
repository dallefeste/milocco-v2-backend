-- Area commerciale: indici per liste ordini cliente (stato calcolato, filtri), conferma, sincronizzazione Onda
-- e preventivi. Nessuna modifica ai dati.
CREATE INDEX IF NOT EXISTS customer_order_date_idx ON customer_order (order_date DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS customer_order_onda_doc_idx ON customer_order (onda_doc_id);
CREATE INDEX IF NOT EXISTS customer_order_line_drawing_idx ON customer_order_line (drawing_id);
CREATE INDEX IF NOT EXISTS production_order_line_idx ON production_order (customer_order_line_id);
CREATE INDEX IF NOT EXISTS cut_queue_item_order_idx ON cut_queue_item (production_order_id);
CREATE INDEX IF NOT EXISTS quote_customer_order_idx ON quote (customer_order_id);
CREATE INDEX IF NOT EXISTS quote_number_norm_idx ON quote (lower(trim(number))) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS quote_part_treatment_qp_idx ON quote_part_treatment (quote_part_id);
CREATE INDEX IF NOT EXISTS customer_onda_idx ON customer (onda_anagrafica_id);
