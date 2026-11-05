/** Stati e valori enumerati del dominio, con le etichette italiane mostrate all'utente. */

const labels = <T extends string>(map: Record<T, string>) => map;

/** Riga di ordine cliente (disegno ordinato): da confermare o confermata in produzione. */
export const ORDER_LINE_STATUSES = ['PENDING', 'CONFIRMED'] as const;
export type OrderLineStatus = (typeof ORDER_LINE_STATUSES)[number];
export const ORDER_LINE_STATUS_LABELS = labels<OrderLineStatus>({ PENDING: 'Da confermare', CONFIRMED: 'Confermata' });

/** Ordine di produzione. */
export const PRODUCTION_ORDER_STATUSES = ['TO_DO', 'IN_PROGRESS', 'COMPLETED'] as const;
export type ProductionOrderStatus = (typeof PRODUCTION_ORDER_STATUSES)[number];
export const PRODUCTION_ORDER_STATUS_LABELS = labels<ProductionOrderStatus>({
  TO_DO: 'Da iniziare',
  IN_PROGRESS: 'In lavorazione',
  COMPLETED: 'Completato',
});

/** Fase eseguita in reparto (registrata dal tablet). */
export const WORK_PHASE_STATUSES = ['IN_PROGRESS', 'COMPLETED', 'SUSPENDED'] as const;
export type WorkPhaseStatus = (typeof WORK_PHASE_STATUSES)[number];
export const WORK_PHASE_STATUS_LABELS = labels<WorkPhaseStatus>({
  IN_PROGRESS: 'In corso',
  COMPLETED: 'Conclusa',
  SUSPENDED: 'Sospesa',
});

/** Coda di taglio barre. */
export const CUT_STATUSES = ['WAITING', 'IN_PROGRESS', 'COMPLETED'] as const;
export type CutStatus = (typeof CUT_STATUSES)[number];
export const CUT_STATUS_LABELS = labels<CutStatus>({ WAITING: 'In attesa', IN_PROGRESS: 'In taglio', COMPLETED: 'Tagliato' });

/** Causale di fermo: pausa (non conta come inefficienza) o interruzione. */
export const STOP_KINDS = ['PAUSE', 'INTERRUPTION'] as const;
export type StopKind = (typeof STOP_KINDS)[number];
export const STOP_KIND_LABELS = labels<StopKind>({ PAUSE: 'Pausa', INTERRUPTION: 'Interruzione' });

export const WEEKDAY_LABELS = ['Lunedì', 'Martedì', 'Mercoledì', 'Giovedì', 'Venerdì', 'Sabato', 'Domenica'] as const;

/** Lavorazione pianificata su una macchina. */
export const SCHEDULE_ITEM_STATUSES = ['OPEN', 'IN_PROGRESS', 'DONE'] as const;
export type ScheduleItemStatus = (typeof SCHEDULE_ITEM_STATUSES)[number];
export const SCHEDULE_ITEM_STATUS_LABELS = labels<ScheduleItemStatus>({ OPEN: 'Da iniziare', IN_PROGRESS: 'In lavorazione', DONE: 'Conclusa' });

/** Approvazione al taglio di un particolare di un ordine di produzione. */
export const PART_CUT_STATUSES = ['NONE', 'APPROVED', 'IGNORED'] as const;
export type PartCutStatus = (typeof PART_CUT_STATUSES)[number];
export const PART_CUT_STATUS_LABELS = labels<PartCutStatus>({ NONE: 'Da approvare', APPROVED: 'In coda di taglio', IGNORED: 'Escluso dal taglio' });

/** Stato calcolato dell'ordine cliente. */
export const CUSTOMER_ORDER_STATUSES = ['INCOMPLETE', 'TO_CONFIRM', 'PARTIALLY_CONFIRMED', 'CONFIRMED'] as const;
export type CustomerOrderStatus = (typeof CUSTOMER_ORDER_STATUSES)[number];
export const CUSTOMER_ORDER_STATUS_LABELS = labels<CustomerOrderStatus>({
  INCOMPLETE: 'Disegni da completare',
  TO_CONFIRM: 'Da confermare',
  PARTIALLY_CONFIRMED: 'Parzialmente confermato',
  CONFIRMED: 'Confermato',
});

/** Stato calcolato di disegno e particolare: da compilare se manca il ciclo di lavorazione. */
export const COMPLETENESS_STATUSES = ['TO_COMPLETE', 'COMPLETE'] as const;
export type CompletenessStatus = (typeof COMPLETENESS_STATUSES)[number];
export const COMPLETENESS_STATUS_LABELS = labels<CompletenessStatus>({ TO_COMPLETE: 'Da compilare', COMPLETE: 'Compilato' });

/** Movimenti di magazzino barre. */
export const BAR_MOVEMENT_KINDS = ['LOAD', 'UNLOAD', 'ADJUST'] as const;
export type BarMovementKind = (typeof BAR_MOVEMENT_KINDS)[number];
export const BAR_MOVEMENT_KIND_LABELS = labels<BarMovementKind>({ LOAD: 'Carico', UNLOAD: 'Scarico', ADJUST: 'Rettifica' });

/** Forme delle barre (codice di 2 lettere nel codice articolo). */
export const BAR_SHAPES: Record<string, string> = {
  PI: 'Piatto', PA: 'Piastra', TO: 'Tondo', QU: 'Quadro', ES: 'Esagono', TT: 'Tubo tondo', TQ: 'Tubo quadro',
  TR: 'Tubo rettangolare', UN: 'UNP', IN: 'INP', IP: 'IPE', HA: 'HEA', HB: 'HEB', AA: 'HEAA', HM: 'HEM',
  AN: 'Angolare', AS: 'Asta',
};

/** Unità di prezzo dei trattamenti esterni. */
export const TREATMENT_PRICE_UNITS = ['KG', 'DM2'] as const;
export type TreatmentPriceUnit = (typeof TREATMENT_PRICE_UNITS)[number];
export const TREATMENT_PRICE_UNIT_LABELS = labels<TreatmentPriceUnit>({ KG: '€/kg', DM2: '€/dm²' });

/** Segnalazioni. */
export const TICKET_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'BLOCKING'] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];
export const TICKET_PRIORITY_LABELS = labels<TicketPriority>({ LOW: 'Bassa', MEDIUM: 'Media', HIGH: 'Alta', BLOCKING: 'Bloccante' });
export const TICKET_STATUSES = ['OPEN', 'IN_PROGRESS', 'TO_VERIFY', 'REJECTED', 'UPDATING', 'RESOLVED', 'NOT_FEASIBLE', 'NOT_REPRODUCIBLE'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];
export const TICKET_STATUS_LABELS = labels<TicketStatus>({
  OPEN: 'Aperta', IN_PROGRESS: 'In lavorazione', TO_VERIFY: 'Da verificare', REJECTED: 'Rifiutata',
  UPDATING: 'In aggiornamento', RESOLVED: 'Risolta', NOT_FEASIBLE: 'Non realizzabile', NOT_REPRODUCIBLE: 'Non riscontrata',
});
