-- Indici per report, cruscotto e ricerca globale (area reports).

-- Riepiloghi giornalieri e report per periodo: fasi per data di inizio/fine, senza filtro per operatore
CREATE INDEX IF NOT EXISTS work_phase_setup_start_idx ON work_phase (setup_started_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS work_phase_work_start_idx ON work_phase (work_started_at) WHERE deleted_at IS NULL;
-- Produzione per giorno (cruscotto)
CREATE INDEX IF NOT EXISTS work_phase_work_end_idx ON work_phase (work_ended_at) WHERE deleted_at IS NULL;
-- Tempi previsti vs consuntivi e carico macchine: fasi collegate a una lavorazione pianificata
CREATE INDEX IF NOT EXISTS work_phase_schedule_item_idx ON work_phase (schedule_item_id) WHERE schedule_item_id IS NOT NULL;

-- Collaudi e lavori extra per giorno
CREATE INDEX IF NOT EXISTS inspection_started_idx ON inspection (started_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS inspection_ended_idx ON inspection (ended_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS extra_activity_log_started_idx ON extra_activity_log (started_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS operator_session_started_idx ON operator_session (started_at);

-- Ordini in ritardo / in scadenza
CREATE INDEX IF NOT EXISTS production_order_delivery_open_idx ON production_order (expected_delivery_date)
  WHERE deleted_at IS NULL AND status <> 'COMPLETED';
-- Contatore ordini cliente da confermare e disegni da completare
CREATE INDEX IF NOT EXISTS customer_order_line_pending_idx ON customer_order_line (customer_order_id, drawing_id)
  WHERE status = 'PENDING' AND deleted_at IS NULL;
-- Ultimi ordini cliente arrivati
CREATE INDEX IF NOT EXISTS customer_order_date_idx ON customer_order (order_date DESC) WHERE deleted_at IS NULL;
-- Particolari da approvare al taglio
CREATE INDEX IF NOT EXISTS production_order_part_cut_none_idx ON production_order_part (part_id) WHERE cut_status = 'NONE';

-- Ricerca globale per prefisso (lower(...) LIKE 'testo%')
CREATE INDEX IF NOT EXISTS customer_order_code_lower_idx ON customer_order (lower(code) text_pattern_ops);
CREATE INDEX IF NOT EXISTS drawing_code_lower_pattern_idx ON drawing (lower(code) text_pattern_ops);
CREATE INDEX IF NOT EXISTS part_code_lower_pattern_idx ON part (lower(internal_code) text_pattern_ops);
CREATE INDEX IF NOT EXISTS quote_number_lower_idx ON quote (lower(number) text_pattern_ops);
