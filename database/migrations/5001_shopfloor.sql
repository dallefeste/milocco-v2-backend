-- App tablet di reparto (area shopfloor).

-- Finestra di ripresa: attività aperte (fasi, collaudi, lavori extra) iniziate da meno di queste ore vengono
-- riprese automaticamente dal tablet dopo un ricaricamento. Quelle più vecchie si chiudono dal backoffice.
INSERT INTO app_setting (key, value, label, description)
VALUES ('tablet_resume_max_hours', '168', 'Tablet: ore entro cui riprendere un''attività aperta',
        'Fasi, collaudi e lavori extra rimasti aperti da più ore di questo valore non vengono riproposti sul tablet.')
ON CONFLICT (key) DO NOTHING;

-- Ricerca rapida delle attività aperte per postazione e operatore (stato del tablet, controllo doppio invio).
CREATE INDEX IF NOT EXISTS work_phase_open_machine_idx ON work_phase (machine_id, operator_id) WHERE status = 'IN_PROGRESS' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS work_stop_open_idx ON work_stop (work_phase_id) WHERE ended_at IS NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS inspection_open_idx ON inspection (operator_id, machine_id) WHERE ended_at IS NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS extra_activity_log_open_idx ON extra_activity_log (operator_id) WHERE ended_at IS NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS operator_session_open_idx ON operator_session (operator_id, machine_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS cut_queue_item_order_part_idx ON cut_queue_item (production_order_id, part_id);
