/**
 * Import dei dati dal vecchio database MySQL al nuovo PostgreSQL.
 * Ogni funzione `import*` legge una o più tabelle del vecchio DB, converte i valori e inserisce le righe
 * nelle tabelle nuove conservando gli id originali dove la tabella ha un corrispettivo diretto.
 * Tutto avviene nella transazione aperta dal chiamante (vedi index.ts).
 */
import type { Connection } from 'mysql2/promise';
import type { PoolClient } from 'pg';
import { parseDimensions } from './dimensions';
import {
  IMPORT_NOW, Row, Stats, bool, deletedAt, groupBy, insertRows, legacyDate, legacyDateTime, maxDate, minDate, num, text,
  timeToSeconds,
  fixRowText,
} from './util';

/** Nota delle registrazioni di reparto rimaste aperte nel vecchio sistema e chiuse dall'import. */
export const AUTO_CLOSED_NOTE = 'Chiusa automaticamente all\'import: era rimasta aperta nel vecchio sistema';

/** Tabelle di dominio (schema 0002) svuotate prima dell'import. app_user, app_setting e schema_migration esclusi. */
export const DOMAIN_TABLES = [
  'customer', 'supplier', 'department', 'operator', 'machine_type', 'machine', 'customer_machine_rate', 'material',
  'finish', 'treatment', 'stop_reason', 'extra_activity', 'work_calendar_day', 'work_calendar_closure', 'bar_type',
  'bar_stock', 'bar_stock_movement', 'drawing', 'part', 'drawing_part', 'drawing_treatment', 'part_cycle_step',
  'file_attachment', 'customer_order', 'customer_order_line', 'quote', 'quote_part', 'quote_part_phase',
  'quote_part_treatment', 'production_order', 'production_order_treatment', 'production_order_part', 'schedule_item',
  'cut_queue_item', 'work_phase', 'work_stop', 'extra_activity_log', 'inspection', 'operator_session',
  'support_ticket', 'audit_log',
];

/** Tabelle del vecchio sistema volutamente non importate (funzioni dismesse o dati senza senso nel nuovo). */
const NOT_IMPORTED: Record<string, string> = {
  ordine_montaggio: 'reparto montaggi dismesso',
  fase_montaggio: 'reparto montaggi dismesso',
  collaudo_montaggio: 'reparto montaggi dismesso',
  fermo_macchina_storico_montaggio: 'reparto montaggi dismesso',
  timbratura: 'funzione dismessa',
  orario_operatore: 'non usato da nessuna funzione',
  orario_sirena: 'non usato da nessuna funzione',
  login: 'solo ora di ingresso, senza uscita né postazione: diventerebbero sessioni aperte per sempre',
  resource: 'i file caricati non sono disponibili (solo riferimenti)',
};

type R = Record<string, any>;

export class Importer {
  readonly stats = new Stats();
  private log: (msg: string) => void;

  // Id presenti nel nuovo DB, per controllare i riferimenti
  private ids = {
    customer: new Set<number>(), supplier: new Set<number>(), department: new Set<number>(), operator: new Set<number>(),
    machineType: new Set<number>(), machine: new Set<number>(), material: new Set<number>(), finish: new Set<number>(),
    treatment: new Set<number>(), stopReason: new Set<number>(), extraActivity: new Set<number>(), barType: new Set<number>(),
    drawing: new Set<number>(), part: new Set<number>(), customerOrder: new Set<number>(), quote: new Set<number>(),
    quotePart: new Set<number>(), productionOrder: new Set<number>(), scheduleItem: new Set<number>(), workPhase: new Set<number>(),
    customerOrderLine: new Set<number>(), productionOrderPart: new Set<number>(),
  };
  /** Cliente segnaposto per gli ordini cliente senza cliente. */
  private unknownCustomerId = 0;
  /** Vecchio id utente → nuovo id app_user. */
  private userMap = new Map<number, number>();
  /** Impostazioni globali del vecchio sistema. */
  private globals = new Map<string, string | null>();

  // Dati del vecchio DB letti una volta e usati da più passi
  private ordini: R[] = [];
  private fasi: R[] = [];
  private collaudi: R[] = [];
  private disegnoParticolare: R[] = [];
  private offerte: R[] = [];
  private offertaDisegno: R[] = [];
  private orderStatus = new Map<number, string>();
  private orderDeleted = new Map<number, boolean>();
  private orderDrawing = new Map<number, number>();
  private orderQty = new Map<number, number>();
  private customerOrderDate = new Map<number, Date>();

  constructor(private my: Connection, private db: PoolClient, log: (msg: string) => void) {
    this.log = log;
  }

  private async q(sql: string): Promise<R[]> {
    const [rows] = await this.my.query(sql);
    return (rows as R[]).map((r) => fixRowText(r));
  }

  private async insert(statsName: string, table: string, rows: Row[]) {
    const n = await insertRows(this.db, table, rows);
    this.stats.imported(statsName, n);
  }

  // ---------------------------------------------------------------------------------------------
  async run() {
    const started = Date.now();
    const step = async (name: string, fn: () => Promise<void>) => {
      const t = Date.now();
      await fn();
      this.log(`  ${name} (${((Date.now() - t) / 1000).toFixed(1)} s)`);
    };
    await step('svuotamento tabelle di dominio', () => this.truncate());
    await step('lettura dati comuni', () => this.preload());
    await step('anagrafiche', () => this.importMasterData());
    await step('magazzino barre', () => this.importBars());
    await step('disegni e particolari', () => this.importTechnical());
    await step('ordini cliente', () => this.importCustomerOrders());
    await step('preventivi', () => this.importQuotes());
    await step('ordini di produzione', () => this.importProductionOrders());
    await step('pianificazione e coda di taglio', () => this.importScheduleAndCut());
    await step('registrazioni di reparto', () => this.importShopfloor());
    await step('utenti e segnalazioni', () => this.importUsersAndTickets());
    await step('impostazioni', () => this.importSettings());
    await step('tabelle non importate', () => this.countNotImported());
    await step('rimozione dati di prova', () => this.removeTestRecords());
    await step('riallineamento sequenze', () => this.resetSequences());
    this.log(`Import completato in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  }

  private async truncate() {
    await this.db.query(`TRUNCATE ${DOMAIN_TABLES.join(', ')} RESTART IDENTITY CASCADE`);
  }

  private async preload() {
    for (const g of await this.q('SELECT chiave, valore FROM impostazione_globale')) this.globals.set(g.chiave, g.valore);
    this.ordini = await this.q('SELECT * FROM ordine ORDER BY id');
    this.fasi = await this.q('SELECT * FROM fase ORDER BY id');
    this.collaudi = await this.q('SELECT * FROM collaudo ORDER BY id');
    this.disegnoParticolare = await this.q('SELECT * FROM disegno_particolare ORDER BY id');
    this.offerte = await this.q('SELECT * FROM offerta ORDER BY id');
    this.offertaDisegno = await this.q('SELECT * FROM offerta_disegno ORDER BY id');
    for (const o of this.ordini) {
      this.orderStatus.set(o.id, mapOrderStatus(o.stato) ?? 'TO_DO');
      this.orderDeleted.set(o.id, bool(o.deleted));
      this.orderDrawing.set(o.id, o.id_disegno);
      this.orderQty.set(o.id, Math.max(0, Number(o.quantita) || 0));
    }
  }

  // ---------------------------------------------------------------------------------------------
  // ANAGRAFICHE
  // ---------------------------------------------------------------------------------------------
  private async importMasterData() {
    const s = this.stats;

    // Reparti
    const productionDept = Number(this.globals.get('id_reparto_produzione'));
    const reparti = await this.q('SELECT * FROM reparto ORDER BY id');
    s.read('reparto → department', reparti.length);
    await this.insert('reparto → department', 'department', reparti.map((r) => {
      this.ids.department.add(r.id);
      return { id: r.id, name: r.nome, is_production: r.id === productionDept, deleted_at: deletedAt(r.deleted) };
    }));

    // Clienti (+ segnaposto per i clienti eliminati fisicamente ma ancora citati)
    const clienti = await this.q('SELECT * FROM cliente ORDER BY id');
    s.read('cliente → customer', clienti.length);
    const custRows: Row[] = clienti.map((c) => {
      this.ids.customer.add(c.id);
      return { id: c.id, name: c.nome ?? '', notes: null, deleted_at: deletedAt(c.deleted) };
    });
    const referenced = [
      ...this.offerte.map((o) => o.id_cliente),
      ...(await this.q('SELECT idCliente AS c FROM preventivo')).map((r) => r.c),
      ...(await this.q('SELECT idCliente AS c FROM macchina_cliente')).map((r) => r.c),
    ].filter((v) => v !== null && Number(v) > 0).map(Number);
    const missing = [...new Set(referenced)].filter((id) => !this.ids.customer.has(id)).sort((a, b) => a - b);
    for (const id of missing) {
      custRows.push({ id, name: `Cliente eliminato nel vecchio sistema (n. ${id})`,
        notes: 'Creato dall\'import: il cliente era stato cancellato dal vecchio database ma ordini o preventivi lo citano ancora.',
        deleted_at: IMPORT_NOW });
      this.ids.customer.add(id);
    }
    if (missing.length) s.fix('cliente → customer', 'cliente ricostruito (eliminato ma citato da ordini cliente/preventivi)', missing.length);
    this.unknownCustomerId = Math.max(0, ...this.ids.customer) + 1;
    custRows.push({ id: this.unknownCustomerId, name: 'Cliente non indicato',
      notes: 'Creato dall\'import: raccoglie gli ordini cliente del vecchio sistema senza cliente.', deleted_at: null });
    this.ids.customer.add(this.unknownCustomerId);
    s.fix('cliente → customer', 'cliente segnaposto "Cliente non indicato" aggiunto');
    await this.insert('cliente → customer', 'customer', custRows);

    // Fornitori
    const fornitori = await this.q('SELECT * FROM fornitore ORDER BY id');
    s.read('fornitore → supplier', fornitori.length);
    await this.insert('fornitore → supplier', 'supplier', fornitori.map((r) => {
      this.ids.supplier.add(r.id);
      return { id: r.id, name: r.nome ?? '', deleted_at: deletedAt(r.deleted) };
    }));

    // Operatori
    const operatori = await this.q('SELECT * FROM operatore ORDER BY id');
    s.read('operatore → operator', operatori.length);
    await this.insert('operatore → operator', 'operator', operatori.map((r) => {
      this.ids.operator.add(r.id);
      let dept: number | null = r.idReparto;
      if (dept !== null && !this.ids.department.has(dept)) { s.fix('operatore → operator', 'reparto inesistente → vuoto'); dept = null; }
      return {
        id: r.id, first_name: r.nome ?? '', last_name: r.cognome ?? '', department_id: dept, badge_number: text(r.badge_number),
        birth_date: legacyDate(r.data_nascita), hire_date: legacyDate(r.data_assunzione),
        active: r.attivo === null ? true : bool(r.attivo), pin_hash: null, deleted_at: deletedAt(r.deleted),
      };
    }));

    // Tipologie macchina: i ruoli fissi del vecchio sistema diventano attributi espliciti
    const tipi = await this.q('SELECT * FROM tipologia_macchina ORDER BY id');
    s.read('tipologia_macchina → machine_type', tipi.length);
    await this.insert('tipologia_macchina → machine_type', 'machine_type', tipi.map((r) => {
      this.ids.machineType.add(r.id);
      const norm = normalizeName(r.nome);
      return {
        id: r.id, name: r.nome, is_cutting: norm === 'TAGLIO', is_inspection: norm === 'COLLAUDO',
        plan_on_order_confirm: ['TORNITURA', 'FRESATURA', 'ELETTROEROSIONE'].includes(norm),
        excel_column: norm, sort_order: r.id * 10, deleted_at: deletedAt(r.deleted),
      };
    }));

    // Macchine
    const macchine = await this.q('SELECT * FROM macchina ORDER BY id');
    s.read('macchina → machine', macchine.length);
    const machineRows: Row[] = [];
    for (const r of macchine) {
      if (!this.ids.machineType.has(r.tipo)) { s.skip('macchina → machine', 'tipologia inesistente'); continue; }
      this.ids.machine.add(r.id);
      machineRows.push({ id: r.id, name: r.nome, machine_type_id: r.tipo, hourly_rate: num(r.prezzoOrario, 2) ?? 0,
        schedulable: bool(r.pianifica), sort_order: r.id, deleted_at: deletedAt(r.deleted) });
    }
    await this.insert('macchina → machine', 'machine', machineRows);

    // Tariffe macchina per cliente
    const mc = await this.q('SELECT * FROM macchina_cliente ORDER BY id');
    s.read('macchina_cliente → customer_machine_rate', mc.length);
    const seenMc = new Set<string>();
    const mcRows: Row[] = [];
    for (const r of mc) {
      if (!this.ids.machine.has(r.idMacchina) || !this.ids.customer.has(r.idCliente)) { s.skip('macchina_cliente → customer_machine_rate', 'macchina o cliente inesistente'); continue; }
      const k = `${r.idMacchina}|${r.idCliente}`;
      if (seenMc.has(k)) { s.skip('macchina_cliente → customer_machine_rate', 'doppione macchina+cliente'); continue; }
      seenMc.add(k);
      mcRows.push({ id: r.id, machine_id: r.idMacchina, customer_id: r.idCliente, hourly_rate: num(r.prezzoOrario, 2) ?? 0 });
    }
    await this.insert('macchina_cliente → customer_machine_rate', 'customer_machine_rate', mcRows);

    // Materiali
    const materiali = await this.q('SELECT * FROM materiale ORDER BY id');
    s.read('materiale → material', materiali.length);
    await this.insert('materiale → material', 'material', materiali.map((r) => {
      this.ids.material.add(r.id);
      return { id: r.id, name: r.nome ?? '', code: text(r.codice), density: num(r.densita) ?? 0, price_per_kg: num(r.prezzoKg) ?? 0, deleted_at: deletedAt(r.deleted) };
    }));

    // Finiture
    const finiture = await this.q('SELECT * FROM finitura ORDER BY id');
    s.read('finitura → finish', finiture.length);
    const finCodes = new Set<string>();
    const finRows: Row[] = [];
    for (const r of finiture) {
      const code = String(r.codice ?? '').trim();
      if (!bool(r.deleted)) {
        if (finCodes.has(code)) { s.skip('finitura → finish', 'codice duplicato'); continue; }
        finCodes.add(code);
      }
      this.ids.finish.add(r.id);
      finRows.push({ id: r.id, name: r.nome ?? '', code, deleted_at: deletedAt(r.deleted) });
    }
    await this.insert('finitura → finish', 'finish', finRows);

    // Trattamenti
    const trattamenti = await this.q('SELECT * FROM trattamento ORDER BY id');
    s.read('trattamento → treatment', trattamenti.length);
    await this.insert('trattamento → treatment', 'treatment', trattamenti.map((r) => {
      this.ids.treatment.add(r.id);
      return { id: r.id, name: r.nome ?? '', required_days: Number(r.giorniNecessari) || 0, unit_price: num(r.prezzoKg),
        unit: mapUnit(r.unitaMisura), deleted_at: deletedAt(r.deleted) };
    }));

    // Causali di fermo
    const fermi = await this.q('SELECT * FROM fermo_macchina ORDER BY id');
    s.read('fermo_macchina → stop_reason', fermi.length);
    await this.insert('fermo_macchina → stop_reason', 'stop_reason', fermi.map((r) => {
      this.ids.stopReason.add(r.id);
      const tipo = String(r.tipo ?? '').trim().toLowerCase();
      let kind = 'INTERRUPTION';
      if (tipo === 'pausa') kind = 'PAUSE';
      else if (tipo !== 'interruzione') s.fix('fermo_macchina → stop_reason', 'tipo non riconosciuto → interruzione');
      return { id: r.id, name: r.nome ?? '', description: text(r.descrizione), kind,
        ends_workday: String(r.nome ?? '').trim().toLowerCase() === 'fine giornata lavorativa', sort_order: r.id, deleted_at: deletedAt(r.deleted) };
    }));

    // Lavori extra
    const extra = await this.q('SELECT * FROM lavoro_extra ORDER BY id');
    s.read('lavoro_extra → extra_activity', extra.length);
    await this.insert('lavoro_extra → extra_activity', 'extra_activity', extra.map((r) => {
      this.ids.extraActivity.add(r.id);
      return { id: r.id, name: r.nome ?? '', deleted_at: deletedAt(r.deleted) };
    }));

    // Orario giornaliero: 00:00-00:00 = chiuso
    const orari = await this.q('SELECT * FROM orario_giornaliero WHERE deleted = 0 OR deleted IS NULL ORDER BY id');
    s.read('orario_giornaliero → work_calendar_day', orari.length);
    const days = new Map<number, Row>();
    for (const r of orari) {
      const wd = Number(r.giorno);
      if (!(wd >= 0 && wd <= 6) || days.has(wd)) { s.skip('orario_giornaliero → work_calendar_day', 'giorno non valido o ripetuto'); continue; }
      const a = timeToSeconds(r.oraInizio);
      const b = timeToSeconds(r.oraFine);
      let start: string | null = r.oraInizio;
      let end: string | null = r.oraFine;
      if (a === null || b === null || b <= a) {
        if (!(a === 0 && b === 0)) s.fix('orario_giornaliero → work_calendar_day', 'orario non valido → giorno chiuso');
        start = null; end = null;
      }
      days.set(wd, { weekday: wd, start_time: start, end_time: end });
    }
    for (let wd = 0; wd <= 6; wd++) if (!days.has(wd)) {
      days.set(wd, { weekday: wd, start_time: null, end_time: null });
      s.fix('orario_giornaliero → work_calendar_day', 'giorno mancante → chiuso');
    }
    await this.insert('orario_giornaliero → work_calendar_day', 'work_calendar_day', [...days.values()]);
  }

  // ---------------------------------------------------------------------------------------------
  // TIPOLOGIE BARRA E GIACENZE
  // ---------------------------------------------------------------------------------------------
  private async importBars() {
    const s = this.stats;
    const name = 'tipologia_barra → bar_type';
    const matCode = new Map((await this.q('SELECT id, codice FROM materiale')).map((r) => [r.id, text(r.codice) ?? '']));
    const finCode = new Map((await this.q('SELECT id, codice FROM finitura')).map((r) => [r.id, String(r.codice ?? '').trim()]));
    const tb = await this.q('SELECT * FROM tipologia_barra ORDER BY id');
    s.read(name, tb.length);
    const codes = new Set<string>();
    const rows: Row[] = [];
    for (const r of tb) {
      const materialId = this.ids.material.has(r.idMateriale) ? r.idMateriale : null;
      const finishId = this.ids.finish.has(r.idFinitura) ? r.idFinitura : null;
      if (materialId === null || finishId === null) s.fix(name, 'materiale o finitura inesistente → vuoto');
      const code = `MP${matCode.get(r.idMateriale) ?? ''}${r.forma ?? ''}${finCode.get(r.idFinitura) ?? ''}${r.dimensioni ?? ''}`;
      if (!bool(r.deleted)) {
        if (codes.has(code)) { s.skip(name, 'codice articolo duplicato'); continue; }
        codes.add(code);
      }
      this.ids.barType.add(r.id);
      rows.push({ id: r.id, code, material_id: materialId, shape: String(r.forma ?? '').trim(), finish_id: finishId,
        dimensions: r.dimensioni ?? '', deleted_at: deletedAt(r.deleted) });
    }
    await this.insert(name, 'bar_type', rows);

    // Il vecchio database non contiene le giacenze (erano nel gestionale contabile esterno): si parte da zero
    // metri e l'ufficio carica le giacenze reali con i movimenti di magazzino.
    const stock = [...this.ids.barType].sort((a, b) => a - b).map((id) => ({ bar_type_id: id, meters: 0,
      description: 'Giacenza iniziale a zero: il vecchio database non conteneva le giacenze.' }));
    s.read('(nuova) bar_stock: una riga a 0 m per tipologia', stock.length);
    await this.insert('(nuova) bar_stock: una riga a 0 m per tipologia', 'bar_stock', stock);
  }

  // ---------------------------------------------------------------------------------------------
  // DISEGNI E PARTICOLARI
  // ---------------------------------------------------------------------------------------------
  private async importTechnical() {
    const s = this.stats;

    // Disegni (+ segnaposto per quelli cancellati fisicamente ma citati da ordini o composizioni)
    const disegni = await this.q('SELECT * FROM disegno ORDER BY id');
    s.read('disegno → drawing', disegni.length);
    const dRows: Row[] = disegni.map((r) => {
      this.ids.drawing.add(r.id);
      const rev = String(r.revisione ?? '');
      if (rev !== rev.trim()) s.fix('disegno → drawing', 'revisione con spazi ripulita');
      else if (rev && !/^[A-Za-z0-9]{1,2}$/.test(rev)) s.fix('disegno → drawing', 'revisione anomala conservata così com\'è (es. ".0", "1-")');
      return { id: r.id, code: r.codice ?? '', revision: rev.trim(), name: r.denominazione ?? '', notes: null, deleted_at: deletedAt(r.deleted) };
    });
    const refDrawings = [
      ...this.ordini.map((o) => o.id_disegno), ...this.offertaDisegno.map((o) => o.idDisegno), ...this.disegnoParticolare.map((d) => d.idDisegno),
    ].filter((v) => v !== null && Number(v) > 0).map(Number);
    const missingD = [...new Set(refDrawings)].filter((id) => !this.ids.drawing.has(id)).sort((a, b) => a - b);
    for (const id of missingD) {
      dRows.push({ id, code: `ELIMINATO-${id}`, revision: '', name: 'Disegno eliminato nel vecchio sistema',
        notes: 'Creato dall\'import: il disegno era stato cancellato dal vecchio database ma ordini o composizioni lo citano ancora.',
        deleted_at: IMPORT_NOW });
      this.ids.drawing.add(id);
    }
    if (missingD.length) s.fix('disegno → drawing', 'disegno ricostruito (eliminato ma citato da ordini/righe/composizioni)', missingD.length);
    await this.insert('disegno → drawing', 'drawing', dRows);

    // Particolari
    const particolari = await this.q('SELECT * FROM particolare ORDER BY id');
    const pn = 'particolare → part';
    s.read(pn, particolari.length);
    const pRows: Row[] = [];
    this.partData = new Map();
    for (const r of particolari) {
      let materialId: number | null = r.id_materiale;
      if (materialId !== null && !this.ids.material.has(materialId)) { s.fix(pn, 'materiale inesistente → vuoto'); materialId = null; }
      let supplierId: number | null = r.id_fornitore;
      if (supplierId !== null && !this.ids.supplier.has(supplierId)) { s.fix(pn, 'fornitore inesistente → vuoto'); supplierId = null; }
      let barTypeId: number | null = r.idTipologiaBarra;
      if (barTypeId !== null && !this.ids.barType.has(barTypeId)) { s.fix(pn, 'tipologia barra inesistente → vuota'); barTypeId = null; }
      const dims = text(r.dimensioni);
      const parsed = parseDimensions(dims);
      if (dims && !parsed) s.fix(pn, 'testo dimensioni non interpretabile: forma e misure vuote (testo conservato)');
      const weight = num(r.peso), dm2 = num(r.dm2Trattamento), kg = num(r.kgTrattamento);
      this.partData.set(r.id, { weight, dm2, kg });
      this.ids.part.add(r.id);
      pRows.push({
        id: r.id, internal_code: r.codice_interno ?? '', name: r.denominazione ?? '', material_id: materialId, supplier_id: supplierId,
        dimensions: dims, shape: parsed?.shape ?? null, shape_params: parsed?.params ?? null, cut_length_mm: parsed?.cutLengthMm ?? null,
        weight_kg: weight, treatment_dm2: dm2, treatment_kg: kg, notes: text(r.note), bar_cut: bool(r.taglioABarra), bar_type_id: barTypeId,
        deleted_at: deletedAt(r.deleted),
      });
    }
    await this.insert(pn, 'part', pRows);

    // Composizione disegni
    const dpn = 'disegno_particolare → drawing_part';
    s.read(dpn, this.disegnoParticolare.length);
    const dpRows: Row[] = [];
    for (const r of this.disegnoParticolare) {
      if (!this.ids.drawing.has(r.idDisegno)) { s.skip(dpn, 'disegno inesistente'); continue; }
      if (!this.ids.part.has(r.idParticolare)) { s.skip(dpn, 'particolare inesistente'); continue; }
      let qty = Number(r.quantita);
      if (!(qty > 0)) { s.fix(dpn, 'quantità 0 o negativa → 1'); qty = 1; }
      dpRows.push({ id: r.id, drawing_id: r.idDisegno, part_id: r.idParticolare, quantity: qty, position: Number(r.numero_particolare) || 0 });
    }
    await this.insert(dpn, 'drawing_part', dpRows);

    // Trattamenti del disegno
    const dtn = 'disegno_trattamento → drawing_treatment';
    const dt = await this.q('SELECT * FROM disegno_trattamento ORDER BY id');
    s.read(dtn, dt.length);
    const seen = new Set<string>();
    const dtRows: Row[] = [];
    for (const r of dt) {
      if (!this.ids.drawing.has(r.idDisegno) || !this.ids.treatment.has(r.idTrattamento)) { s.skip(dtn, 'disegno o trattamento inesistente'); continue; }
      const k = `${r.idDisegno}|${r.idTrattamento}`;
      if (seen.has(k)) { s.skip(dtn, 'doppione'); continue; }
      seen.add(k);
      dtRows.push({ drawing_id: r.idDisegno, treatment_id: r.idTrattamento });
    }
    await this.insert(dtn, 'drawing_treatment', dtRows);

    // Ciclo di lavorazione: la sequenza è l'ordine di inserimento (id crescente) per particolare
    const csn = 'particolare_tipologia_macchina → part_cycle_step';
    const ptm = await this.q('SELECT * FROM particolare_tipologia_macchina ORDER BY idParticolare, id');
    s.read(csn, ptm.length);
    const seqByPart = new Map<number, number>();
    const csRows: Row[] = [];
    for (const r of ptm) {
      if (!this.ids.part.has(r.idParticolare)) { s.skip(csn, 'particolare inesistente'); continue; }
      if (!this.ids.machineType.has(r.idTipologiaMacchina)) { s.skip(csn, 'tipologia macchina inesistente'); continue; }
      const seq = (seqByPart.get(r.idParticolare) ?? 0) + 1;
      seqByPart.set(r.idParticolare, seq);
      csRows.push({ id: r.id, part_id: r.idParticolare, machine_type_id: r.idTipologiaMacchina, sequence: seq,
        setup_seconds: this.duration(csn, r.durataAttrezzaggio), unit_seconds: this.duration(csn, r.durataLavorazione),
        planned_man_minutes: r.minutiUomoPrevisti === null ? null : Number(r.minutiUomoPrevisti) });
    }
    await this.insert(csn, 'part_cycle_step', csRows);
  }

  private partData = new Map<number, { weight: number | null; dm2: number | null; kg: number | null }>();

  /** Durata TIME → secondi; nulla, illeggibile o negativa → 0 (contata come correzione). */
  private duration(statsName: string, v: unknown): number {
    const secs = timeToSeconds(v);
    if (secs === null) { this.stats.fix(statsName, 'durata vuota → 0'); return 0; }
    if (secs < 0) { this.stats.fix(statsName, 'durata negativa → 0'); return 0; }
    return secs;
  }

  // ---------------------------------------------------------------------------------------------
  // ORDINI CLIENTE
  // ---------------------------------------------------------------------------------------------
  private async importCustomerOrders() {
    const s = this.stats;
    const con = 'offerta → customer_order';
    s.read(con, this.offerte.length);

    // Data stimata per gli ordini cliente senza data: prima attività (fase o collaudo) dei loro ordini di produzione
    const firstActivityByOrder = this.firstActivityByOrder();
    const activityByOffer = new Map<number, Date>();
    for (const o of this.ordini) {
      const d = firstActivityByOrder.get(o.id);
      if (!d) continue;
      const cur = activityByOffer.get(o.id_offerta);
      if (!cur || d < cur) activityByOffer.set(o.id_offerta, d);
    }

    // Segnaposto per gli ordini cliente cancellati fisicamente ma citati da ordini di produzione
    const known = new Set(this.offerte.map((o) => o.id as number));
    const missing = [...new Set(this.ordini.map((o) => Number(o.id_offerta)))].filter((id) => id > 0 && !known.has(id)).sort((a, b) => a - b);
    const all: R[] = [
      ...this.offerte,
      ...missing.map((id) => ({ id, codice_interno: `ELIMINATO-${id}`, id_cliente: null, data: null,
        note: 'Creato dall\'import: l\'ordine cliente era stato cancellato dal vecchio database ma ordini di produzione lo citano ancora.',
        IdDoc: null, deleted: 1, placeholder: true })),
    ].sort((a, b) => a.id - b.id);
    if (missing.length) s.fix(con, 'ordine cliente ricostruito (eliminato ma citato da ordini di produzione)', missing.length);

    // Prima passata: date reali o stimate dall'attività; seconda: riempimento con la data dell'ordine cliente vicino
    const dates = new Map<number, Date | null>();
    let estimated = 0;
    for (const o of all) {
      let d = legacyDateTime(o.data);
      if (!d) { d = activityByOffer.get(o.id) ?? null; if (d) estimated++; }
      dates.set(o.id, d);
    }
    let prev: Date | null = null;
    let carried = 0;
    for (const o of all) {
      const d = dates.get(o.id);
      if (d) prev = d;
      else if (prev) { dates.set(o.id, prev); carried++; }
    }
    const firstKnown = [...dates.values()].find((d) => d) ?? IMPORT_NOW;
    for (const o of all) if (!dates.get(o.id)) { dates.set(o.id, firstKnown); carried++; }
    if (estimated) s.fix(con, 'data mancante stimata con la prima fase/collaudo dei suoi ordini di produzione', estimated);
    if (carried) s.fix(con, 'data mancante stimata con la data dell\'ordine cliente precedente (numerazione)', carried);

    const rows: Row[] = [];
    for (const o of all) {
      let customerId: number = o.id_cliente;
      if (customerId === null || customerId === undefined || !this.ids.customer.has(customerId)) {
        customerId = this.unknownCustomerId;
        if (!o.placeholder) s.fix(con, 'cliente mancante (0 o vuoto) → "Cliente non indicato"');
      }
      const date = dates.get(o.id)!;
      this.customerOrderDate.set(o.id, date);
      this.ids.customerOrder.add(o.id);
      rows.push({ id: o.id, code: o.codice_interno ?? '', customer_id: customerId, order_date: date, notes: text(o.note),
        created_at: date, deleted_at: deletedAt(o.deleted) });
    }
    await this.insert(con, 'customer_order', rows);

    // Righe ordine cliente
    const ln = 'offerta_disegno → customer_order_line';
    s.read(ln, this.offertaDisegno.length);
    const lRows: Row[] = [];
    for (const r of this.offertaDisegno) {
      if (!this.ids.customerOrder.has(r.idOfferta)) { s.skip(ln, 'ordine cliente inesistente'); continue; }
      if (!this.ids.drawing.has(r.idDisegno)) { s.skip(ln, 'disegno inesistente'); continue; }
      let qty = Number(r.quantita) || 0;
      if (qty < 0) { s.fix(ln, 'quantità negativa → 0'); qty = 0; }
      let status = 'PENDING';
      if (r.stato === '1_CONFERMATA') status = 'CONFIRMED';
      else if (r.stato !== '0_DA_CONFERMARE') s.fix(ln, 'stato sconosciuto → da confermare');
      this.ids.customerOrderLine.add(r.id);
      const date = this.customerOrderDate.get(r.idOfferta) ?? IMPORT_NOW;
      lRows.push({ id: r.id, customer_order_id: r.idOfferta, drawing_id: r.idDisegno, quantity: qty, status, notes: text(r.note), created_at: date });
    }
    await this.insert(ln, 'customer_order_line', lRows);
  }

  /** Prima attività registrata (inizio attrezzaggio o collaudo) per ordine di produzione. */
  private firstActivityByOrder(): Map<number, Date> {
    const m = new Map<number, Date>();
    const add = (order: number, d: Date | null) => {
      if (!d) return;
      const cur = m.get(order);
      if (!cur || d < cur) m.set(order, d);
    };
    for (const f of this.fasi) if (!bool(f.deleted)) add(f.id_ordine, legacyDateTime(f.inizio_attrezzaggio));
    for (const c of this.collaudi) if (!bool(c.deleted)) add(c.id_ordine, legacyDateTime(c.inizio));
    return m;
  }

  // ---------------------------------------------------------------------------------------------
  // PREVENTIVI
  // ---------------------------------------------------------------------------------------------
  private async importQuotes() {
    const s = this.stats;
    const qn = 'preventivo → quote';
    const prev = await this.q('SELECT * FROM preventivo ORDER BY id');
    s.read(qn, prev.length);
    const qRows: Row[] = [];
    for (const r of prev) {
      if (!this.ids.customer.has(r.idCliente)) { s.skip(qn, 'cliente inesistente'); continue; }
      let co: number | null = r.idOfferta;
      if (co !== null && !this.ids.customerOrder.has(co)) { s.fix(qn, 'ordine cliente inesistente → vuoto'); co = null; }
      if (r.idResourceExcelImportato) s.fix(qn, 'riferimento al file Excel importato tolto (file non disponibile)');
      this.ids.quote.add(r.id);
      qRows.push({ id: r.id, number: r.numero ?? '', customer_id: r.idCliente, issue_date: legacyDate(r.dataEmissione) ?? legacyDate(IMPORT_NOW.toISOString()),
        expected_delivery_date: legacyDate(r.dataConsegnaPrevista), material_markup: num(r.fattoreRicaricoMateriale) ?? 1.15,
        markup: num(r.fattoreRicarico) ?? 1.25, customer_order_id: co, imported_file_id: null, notes: text(r.note), deleted_at: deletedAt(r.deleted) });
    }
    await this.insert(qn, 'quote', qRows);

    const qpn = 'particolare_preventivo → quote_part';
    const pp = await this.q('SELECT * FROM particolare_preventivo ORDER BY idPreventivo, id');
    s.read(qpn, pp.length);
    const qpRows: Row[] = [];
    const sortByQuote = new Map<number, number>();
    for (const r of pp) {
      if (!this.ids.quote.has(r.idPreventivo)) { s.skip(qpn, 'preventivo inesistente'); continue; }
      if (!this.ids.part.has(r.idParticolare)) { s.skip(qpn, 'particolare inesistente'); continue; }
      const sort = (sortByQuote.get(r.idPreventivo) ?? 0) + 1;
      sortByQuote.set(r.idPreventivo, sort);
      const pd = this.partData.get(r.idParticolare);
      this.ids.quotePart.add(r.id);
      qpRows.push({ id: r.id, quote_id: r.idPreventivo, part_id: r.idParticolare, quantity: Math.max(0, Number(r.quantita) || 0),
        production_quantity: Math.max(0, Number(r.quantitaDaProdurre) || 0),
        cam_seconds: r.tempoProgrammazioneCAM === null ? 0 : this.duration(qpn, r.tempoProgrammazioneCAM),
        cam_price_per_minute: num(r.prezzoMinutoProgrammazioneCAM) ?? 0, material_price_per_kg: num(r.prezzoKgMateriale) ?? 0,
        weight_kg: pd?.weight ?? null, treatment_kg: pd?.kg ?? null, treatment_dm2: pd?.dm2 ?? null,
        notes: text(r.note), sort_order: sort, deleted_at: deletedAt(r.deleted) });
    }
    await this.insert(qpn, 'quote_part', qpRows);

    const phn = 'fase_lavorazione_particolare_preventivo → quote_part_phase';
    const ph = await this.q('SELECT * FROM fase_lavorazione_particolare_preventivo ORDER BY idParticolarePreventivo, id');
    s.read(phn, ph.length);
    const phRows: Row[] = [];
    const seqByQp = new Map<number, number>();
    for (const r of ph) {
      if (bool(r.deleted)) { s.skip(phn, 'fase cancellata (la tabella nuova non ha eliminazione logica)'); continue; }
      if (!this.ids.quotePart.has(r.idParticolarePreventivo)) { s.skip(phn, 'riga preventivo inesistente'); continue; }
      if (!this.ids.machineType.has(r.idTipologiaMacchina)) { s.skip(phn, 'tipologia macchina inesistente'); continue; }
      let machineId: number | null = r.idMacchina;
      if (machineId !== null && !this.ids.machine.has(machineId)) { s.fix(phn, 'macchina inesistente → vuota'); machineId = null; }
      const seq = (seqByQp.get(r.idParticolarePreventivo) ?? 0) + 1;
      seqByQp.set(r.idParticolarePreventivo, seq);
      phRows.push({ id: r.id, quote_part_id: r.idParticolarePreventivo, machine_type_id: r.idTipologiaMacchina, machine_id: machineId, sequence: seq,
        programming_seconds: r.durataProgrammazione === null ? 0 : this.duration(phn, r.durataProgrammazione),
        setup_seconds: r.durataAttrezzaggio === null ? 0 : this.duration(phn, r.durataAttrezzaggio),
        unit_seconds: this.duration(phn, r.durataLavorazione), machine_hourly_rate: num(r.prezzoOrarioMacchina, 2) ?? 0 });
    }
    await this.insert(phn, 'quote_part_phase', phRows);

    const tn = 'trattamento_particolare_preventivo → quote_part_treatment';
    const tr = await this.q('SELECT * FROM trattamento_particolare_preventivo ORDER BY id');
    s.read(tn, tr.length);
    const tRows: Row[] = [];
    for (const r of tr) {
      if (!this.ids.quotePart.has(r.idParticolarePreventivo) || !this.ids.treatment.has(r.idTrattamento)) { s.skip(tn, 'riga preventivo o trattamento inesistente'); continue; }
      let unit = mapUnit(r.unitaMisura);
      if (!unit) { s.fix(tn, 'unità di misura vuota → KG'); unit = 'KG'; }
      tRows.push({ id: r.id, quote_part_id: r.idParticolarePreventivo, treatment_id: r.idTrattamento, unit_price: num(r.prezzoKg) ?? 0, unit });
    }
    await this.insert(tn, 'quote_part_treatment', tRows);
  }

  // ---------------------------------------------------------------------------------------------
  // ORDINI DI PRODUZIONE
  // ---------------------------------------------------------------------------------------------
  private dpQty = new Map<string, number>();

  private async importProductionOrders() {
    const s = this.stats;
    const on = 'ordine → production_order';
    s.read(on, this.ordini.length);

    // Quantità del particolare nel disegno (prima riga della composizione)
    for (const dp of this.disegnoParticolare) {
      const k = `${dp.idDisegno}|${dp.idParticolare}`;
      if (!this.dpQty.has(k)) this.dpQty.set(k, Number(dp.quantita) > 0 ? Number(dp.quantita) : 1);
    }
    // Righe ordine cliente per (ordine cliente, disegno)
    const lines = groupBy(this.offertaDisegno.filter((r) => this.ids.customerOrderLine.has(r.id)), (r) => `${r.idOfferta}|${r.idDisegno}`);
    const firstActivity = this.firstActivityByOrder();
    const lastInspectionEnd = new Map<number, Date>();
    for (const c of this.collaudi) {
      if (bool(c.deleted)) continue;
      const d = legacyDateTime(c.fine);
      const cur = lastInspectionEnd.get(c.id_ordine);
      if (d && (!cur || d > cur)) lastInspectionEnd.set(c.id_ordine, d);
    }
    const lastPhaseEnd = new Map<number, Date>();
    for (const f of this.fasi) {
      if (bool(f.deleted)) continue;
      const d = maxDate(legacyDateTime(f.fine_lavorazione), legacyDateTime(f.fine_attrezzaggio));
      const cur = lastPhaseEnd.get(f.id_ordine);
      if (d && (!cur || d > cur)) lastPhaseEnd.set(f.id_ordine, d);
    }

    const rows: Row[] = [];
    for (const o of this.ordini) {
      if (!this.ids.customerOrder.has(o.id_offerta)) { s.skip(on, 'ordine cliente inesistente'); continue; }
      if (!this.ids.drawing.has(o.id_disegno)) { s.skip(on, 'disegno inesistente'); continue; }
      let qty = Number(o.quantita) || 0;
      if (qty < 0) { s.fix(on, 'quantità negativa → 0'); qty = 0; }
      let stock = Number(o.quantitaAMagazzino) || 0;
      if (stock < 0) { s.fix(on, 'quantità a magazzino negativa → 0'); stock = 0; }
      const status = mapOrderStatus(o.stato);
      if (!status) s.fix(on, 'stato sconosciuto → da iniziare');
      const ls = lines.get(`${o.id_offerta}|${o.id_disegno}`);
      let lineId: number | null = null;
      if (ls && ls.length === 1) lineId = ls[0].id;
      else if (ls && ls.length > 1) s.fix(on, 'riga ordine cliente non determinabile (più righe con lo stesso disegno) → vuota');
      else s.fix(on, 'nessuna riga ordine cliente con lo stesso disegno → collegamento vuoto');
      let completedAt: Date | null = null;
      if (status === 'COMPLETED') completedAt = lastInspectionEnd.get(o.id) ?? lastPhaseEnd.get(o.id) ?? null;
      this.ids.productionOrder.add(o.id);
      rows.push({ id: o.id, customer_order_id: o.id_offerta, customer_order_line_id: lineId, drawing_id: o.id_disegno, quantity: qty,
        stock_quantity: stock, expected_delivery_date: legacyDate(o.dataConsegnaPrevista), status: status ?? 'TO_DO',
        started_at: firstActivity.get(o.id) ?? null, completed_at: completedAt, notes: text(o.note),
        created_at: this.customerOrderDate.get(o.id_offerta) ?? IMPORT_NOW, deleted_at: deletedAt(o.deleted) });
    }
    await this.insert(on, 'production_order', rows);

    // Trattamenti dell'ordine
    const tn = 'ordine_trattamento → production_order_treatment';
    const ot = await this.q('SELECT * FROM ordine_trattamento ORDER BY id');
    s.read(tn, ot.length);
    const seen = new Set<string>();
    const tRows: Row[] = [];
    for (const r of ot) {
      if (!this.ids.productionOrder.has(r.idOrdine) || !this.ids.treatment.has(r.idTrattamento)) { s.skip(tn, 'ordine o trattamento inesistente'); continue; }
      const k = `${r.idOrdine}|${r.idTrattamento}`;
      if (seen.has(k)) { s.skip(tn, 'doppione'); continue; }
      seen.add(k);
      tRows.push({ production_order_id: r.idOrdine, treatment_id: r.idTrattamento });
    }
    await this.insert(tn, 'production_order_treatment', tRows);

    // Particolari dell'ordine con stato di approvazione al taglio
    const pn = 'ordine_particolare → production_order_part';
    const op = await this.q('SELECT * FROM ordine_particolare ORDER BY id');
    s.read(pn, op.length);
    const pRows: Row[] = [];
    this.orderPartByKey = new Map();
    for (const r of op) {
      if (!this.ids.productionOrder.has(r.idOrdine)) { s.skip(pn, 'ordine inesistente'); continue; }
      if (!this.ids.part.has(r.idParticolare)) { s.skip(pn, 'particolare inesistente'); continue; }
      const k = `${this.orderDrawing.get(r.idOrdine)}|${r.idParticolare}`;
      let q = this.dpQty.get(k);
      if (q === undefined) { s.fix(pn, 'particolare non più nel disegno dell\'ordine: quantità per unità = 1'); q = 1; }
      const cut = bool(r.ignoratoTaglio) ? 'IGNORED' : bool(r.importatoTaglio) ? 'APPROVED' : 'NONE';
      const key = `${r.idOrdine}|${r.idParticolare}`;
      if (!this.orderPartByKey.has(key)) this.orderPartByKey.set(key, r.id);
      this.ids.productionOrderPart.add(r.id);
      pRows.push({ id: r.id, production_order_id: r.idOrdine, part_id: r.idParticolare, quantity_per_unit: q, cut_status: cut });
    }
    await this.insert(pn, 'production_order_part', pRows);
  }

  private orderPartByKey = new Map<string, number>();

  // ---------------------------------------------------------------------------------------------
  // PIANIFICAZIONE E CODA DI TAGLIO
  // ---------------------------------------------------------------------------------------------
  private lavorazioneByFase = new Map<number, number>();

  private async importScheduleAndCut() {
    const s = this.stats;
    const sn = 'lavorazione → schedule_item';
    const lav = await this.q('SELECT * FROM lavorazione ORDER BY id');
    s.read(sn, lav.length);
    const lf = await this.q('SELECT * FROM lavorazione_fase ORDER BY id');
    const fasiById = new Map(this.fasi.map((f) => [f.id as number, f]));
    // Prima lavorazione collegata a ogni fase (se una fase è collegata a più lavorazioni si prende la prima)
    for (const r of lf) if (!this.lavorazioneByFase.has(r.idFase)) this.lavorazioneByFase.set(r.idFase, r.idLavorazione);
    const fasiByLav = groupBy(lf, (r) => r.idLavorazione as number);

    const rows: Row[] = [];
    for (const r of lav) {
      if (!this.ids.productionOrder.has(r.idOrdine)) { s.skip(sn, 'ordine inesistente'); continue; }
      if (!this.ids.part.has(r.idParticolare)) { s.skip(sn, 'particolare inesistente'); continue; }
      if (!this.ids.machine.has(r.idMacchina)) { s.skip(sn, 'macchina inesistente'); continue; }
      const linked = (fasiByLav.get(r.id) ?? []).map((x) => fasiById.get(x.idFase)).filter((f): f is R => !!f && !bool(f.deleted));
      const orderCompleted = this.orderStatus.get(r.idOrdine) === 'COMPLETED';
      const completedPhases = linked.filter((f) => String(f.stato) === '1');
      // Lo stato si calcola sulle fasi davvero concluse nel vecchio sistema. Le fasi rimaste aperte (in corso o
      // sospese) vengono chiuse dall'import (vedi importShopfloor): la lavorazione non è finita, resta da fare.
      let status = 'OPEN';
      if (completedPhases.length > 0 || orderCompleted) status = 'DONE';
      else if (linked.some((f) => String(f.stato) === '0' || String(f.stato) === '2')) {
        s.fix(sn, 'lavorazione con fasi rimaste aperte nel vecchio sistema (chiuse all\'import) → da fare invece di in corso');
      }
      const completedAt = maxDate(...completedPhases.map((f) => legacyDateTime(f.fine_lavorazione) ?? legacyDateTime(f.fine_attrezzaggio)));
      const dpq = this.dpQty.get(`${this.orderDrawing.get(r.idOrdine)}|${r.idParticolare}`);
      if (dpq === undefined) s.fix(sn, 'particolare non nel disegno dell\'ordine: quantità = quantità ordine');
      const qty = (this.orderQty.get(r.idOrdine) ?? 0) * (dpq ?? 1);
      let del = deletedAt(r.deleted);
      if (!del && status !== 'DONE' && this.orderDeleted.get(r.idOrdine)) {
        s.fix(sn, 'lavorazione non conclusa di un ordine eliminato → eliminata');
        del = IMPORT_NOW;
      }
      this.ids.scheduleItem.add(r.id);
      rows.push({ id: r.id, production_order_id: r.idOrdine, part_id: r.idParticolare, machine_id: r.idMacchina,
        setup_seconds: this.duration(sn, r.durataAttrezzaggio), unit_seconds: this.duration(sn, r.durataLavorazione),
        internal_pause_seconds: this.duration(sn, r.durataPausaInterna), end_pause_seconds: this.duration(sn, r.durataPausaFineLavorazione),
        quantity: qty, position: num(r.ordine, 4) ?? 0, status, completed_at: completedAt,
        created_at: legacyDateTime(r.dataInserimento) ?? IMPORT_NOW, deleted_at: del });
    }
    await this.insert(sn, 'schedule_item', rows);

    // Coda di taglio
    const cn = 'scheduler_taglio → cut_queue_item';
    const st = await this.q('SELECT * FROM scheduler_taglio ORDER BY id');
    s.read(cn, st.length);
    const cRows: Row[] = [];
    for (const r of st) {
      if (!this.ids.productionOrder.has(r.idOrdine)) { s.skip(cn, 'ordine inesistente'); continue; }
      if (!this.ids.part.has(r.idParticolare)) { s.skip(cn, 'particolare inesistente'); continue; }
      const status = ({ '0_IN_ATTESA': 'WAITING', '1_IN_LAVORAZIONE': 'IN_PROGRESS', '2_COMPLETATO': 'COMPLETED' } as Record<string, string>)[r.stato];
      if (!status) s.fix(cn, 'stato sconosciuto → in attesa');
      let del = deletedAt(r.deleted);
      const ordStatus = this.orderStatus.get(r.idOrdine);
      if (!del && (status ?? 'WAITING') === 'WAITING' && (this.orderDeleted.get(r.idOrdine) || ordStatus === 'COMPLETED')) {
        s.fix(cn, 'taglio non iniziato di un ordine completato o eliminato → eliminato');
        del = IMPORT_NOW;
      }
      cRows.push({ id: r.id, production_order_id: r.idOrdine, production_order_part_id: this.orderPartByKey.get(`${r.idOrdine}|${r.idParticolare}`) ?? null,
        part_id: r.idParticolare, position: num(r.ordine, 4) ?? 0, status: status ?? 'WAITING', started_at: null,
        completed_at: legacyDateTime(r.dataCompletamento), deleted_at: del });
    }
    await this.insert(cn, 'cut_queue_item', cRows);
  }

  // ---------------------------------------------------------------------------------------------
  // REGISTRAZIONI DI REPARTO (tablet)
  // ---------------------------------------------------------------------------------------------
  private async importShopfloor() {
    const s = this.stats;
    const fn = 'fase → work_phase';
    s.read(fn, this.fasi.length);
    // Ripresa: nelle fasi con stesso ordine+particolare+numero fase, ognuna riprende la precedente se era sospesa
    const resumedFrom = new Map<number, number>();
    for (const group of groupBy(this.fasi, (f) => `${f.id_ordine}|${f.id_particolare}|${f.numero_fase}`).values()) {
      for (let i = 1; i < group.length; i++) if (String(group[i - 1].stato) === '2') resumedFrom.set(group[i].id, group[i - 1].id);
    }
    const rows: Row[] = [];
    for (const f of this.fasi) {
      if (!this.ids.productionOrder.has(f.id_ordine)) { s.skip(fn, 'ordine inesistente'); continue; }
      if (!this.ids.operator.has(f.id_operatore)) { s.skip(fn, 'operatore inesistente'); continue; }
      if (!this.ids.machine.has(f.id_macchina)) { s.skip(fn, 'macchina inesistente'); continue; }
      const setupStart = legacyDateTime(f.inizio_attrezzaggio);
      if (!setupStart) { s.skip(fn, 'inizio attrezzaggio mancante'); continue; }
      let partId: number | null = f.id_particolare;
      if (partId !== null && !this.ids.part.has(partId)) { s.fix(fn, 'particolare inesistente → vuoto'); partId = null; }
      const status = ({ '0': 'IN_PROGRESS', '1': 'COMPLETED', '2': 'SUSPENDED' } as Record<string, string>)[String(f.stato)];
      if (!status) s.fix(fn, 'stato sconosciuto → in corso (poi chiusa come le altre fasi aperte)');
      const lavId = this.lavorazioneByFase.get(f.id);
      const scheduleItemId = lavId !== undefined && this.ids.scheduleItem.has(lavId) ? lavId : null;
      const wEnd = legacyDateTime(f.fine_lavorazione), wStart = legacyDateTime(f.inizio_lavorazione);
      if (wEnd && wStart && wEnd < wStart) s.fix(fn, 'fine lavorazione prima dell\'inizio (orari conservati)');
      const nonNeg = (v: unknown) => {
        if (v === null || v === undefined) return null;
        const n = Number(v);
        if (n < 0) { s.fix(fn, 'pezzi negativi → vuoto'); return null; }
        return n;
      };
      const resumed = resumedFrom.get(f.id);
      this.ids.workPhase.add(f.id);
      rows.push({ id: f.id, production_order_id: f.id_ordine, part_id: partId, operator_id: f.id_operatore, machine_id: f.id_macchina,
        schedule_item_id: scheduleItemId, phase_number: Number(f.numero_fase) || 1,
        resumed_from_id: resumed !== undefined && this.ids.workPhase.has(resumed) ? resumed : null,
        status: status ?? 'IN_PROGRESS', setup_started_at: setupStart, setup_ended_at: legacyDateTime(f.fine_attrezzaggio),
        work_started_at: wStart, work_ended_at: wEnd, good_qty: nonNeg(f.pezzi_buoni), scrap_qty: nonNeg(f.pezzi_scartati),
        avg_unit_seconds: num(f.tempo_medio_unitario, 2), created_at: setupStart, deleted_at: deletedAt(f.deleted) });
    }
    this.closeOpenPhases(fn, rows);
    await this.insert(fn, 'work_phase', rows);

    // Fermi e pause
    const wn = 'fermo_macchina_storico → work_stop';
    const fms = await this.q('SELECT * FROM fermo_macchina_storico ORDER BY id');
    s.read(wn, fms.length);
    const wRows: Row[] = [];
    for (const r of fms) {
      if (!this.ids.workPhase.has(r.id_fase)) { s.skip(wn, 'fase inesistente'); continue; }
      const start = legacyDateTime(r.inizio);
      if (!start) { s.skip(wn, 'inizio mancante'); continue; }
      let reason: number | null = r.id_fermo_macchina;
      if (reason !== null && !this.ids.stopReason.has(reason)) { s.fix(wn, 'causale inesistente → vuota'); reason = null; }
      const end = this.closeIfOpen(wn, 'work_stop', r.id, start, legacyDateTime(r.fine), 'fermo');
      wRows.push({ id: r.id, work_phase_id: r.id_fase, stop_reason_id: reason, started_at: start, ended_at: end,
        machine_stopped: bool(r.macchinaFerma), created_at: start, deleted_at: deletedAt(r.deleted) });
    }
    await this.insert(wn, 'work_stop', wRows);

    // Lavori extra registrati
    const en = 'lavoro_extra_storico → extra_activity_log';
    const les = await this.q('SELECT * FROM lavoro_extra_storico ORDER BY id');
    s.read(en, les.length);
    const eRows: Row[] = [];
    for (const r of les) {
      if (!this.ids.operator.has(r.id_operatore)) { s.skip(en, 'operatore inesistente'); continue; }
      if (!this.ids.extraActivity.has(r.id_lavoro_extra)) { s.skip(en, 'lavoro extra inesistente'); continue; }
      const start = legacyDateTime(r.inizio);
      if (!start) { s.skip(en, 'inizio mancante'); continue; }
      eRows.push({ id: r.id, operator_id: r.id_operatore, extra_activity_id: r.id_lavoro_extra, machine_id: null, started_at: start,
        ended_at: this.closeIfOpen(en, 'extra_activity_log', r.id, start, legacyDateTime(r.fine), 'lavoro extra'),
        created_at: start, deleted_at: deletedAt(r.deleted) });
    }
    await this.insert(en, 'extra_activity_log', eRows);

    // Collaudi: nel vecchio sistema non avevano la macchina; si usa la postazione di collaudo se è una sola
    const inspMachines = (await this.db.query(
      `SELECT m.id FROM machine m JOIN machine_type t ON t.id = m.machine_type_id WHERE t.is_inspection AND m.deleted_at IS NULL`)).rows;
    const inspMachine: number | null = inspMachines.length === 1 ? inspMachines[0].id : null;
    const in_ = 'collaudo → inspection';
    s.read(in_, this.collaudi.length);
    const iRows: Row[] = [];
    for (const r of this.collaudi) {
      if (!this.ids.productionOrder.has(r.id_ordine)) { s.skip(in_, 'ordine inesistente (eliminato dal vecchio database)'); continue; }
      if (!this.ids.operator.has(r.id_operatore)) { s.skip(in_, 'operatore inesistente'); continue; }
      const start = legacyDateTime(r.inizio);
      if (!start) { s.skip(in_, 'inizio mancante'); continue; }
      const nn = (v: unknown) => (v === null || v === undefined || Number(v) < 0 ? null : Number(v));
      const legacyEnd = legacyDateTime(r.fine);
      const end = this.closeIfOpen(in_, 'inspection', r.id, start, legacyEnd, 'collaudo');
      const notes = legacyEnd ? text(r.note) : [text(r.note), AUTO_CLOSED_NOTE].filter(Boolean).join('\n');
      iRows.push({ id: r.id, production_order_id: r.id_ordine, operator_id: r.id_operatore, machine_id: inspMachine, started_at: start,
        ended_at: end, good_qty: nn(r.pezzi_buoni), scrap_qty: nn(r.pezzi_scartati), notes,
        created_at: start, deleted_at: deletedAt(r.deleted) });
    }
    await this.insert(in_, 'inspection', iRows);

    // Registro modifiche: una voce per ogni registrazione chiusa d'ufficio (è la "nota" di fasi, fermi e lavori extra).
    const an = '(nuova) audit_log: chiusure automatiche';
    s.read(an, this.autoClosed.length);
    await this.insert(an, 'audit_log', this.autoClosed.map((c) => ({
      user_id: null, username: 'import', entity: c.entity, entity_id: String(c.id), action: 'UPDATE',
      summary: AUTO_CLOSED_NOTE, changes: c.changes, created_at: IMPORT_NOW,
    })));
  }

  /**
   * Fasi rimaste aperte nel vecchio sistema (anni fa): in corso, oppure sospese e mai riprese. Diventano concluse;
   * la fine attrezzaggio mancante prende l'ultimo istante già registrato sulla fase (inizio lavorazione o inizio
   * attrezzaggio), la fine lavorazione mancante l'inizio lavorazione: la durata aggiunta è zero. La nota va nel registro modifiche (la fase non ha note).
   * Le fasi sospese e poi riprese restano "sospese": è lo stato normale di una fase ripresa (il lavoro è continuato
   * nella fase di ripresa) e hanno già gli orari di fine.
   */
  private closeOpenPhases(statsName: string, rows: Row[]) {
    const resumed = new Set<unknown>(rows.map((r) => r.resumed_from_id).filter((id) => id !== null));
    for (const r of rows) {
      const from = r.status as string;
      if (from === 'COMPLETED' || (from === 'SUSPENDED' && resumed.has(r.id))) continue;
      const last = maxDate(r.setup_started_at as Date, r.setup_ended_at as Date | null, r.work_started_at as Date | null, r.work_ended_at as Date | null)!;
      const filled: Record<string, string> = {};
      if (!r.setup_ended_at) { r.setup_ended_at = last; filled.setupEndedAt = last.toISOString(); }
      // Fine lavorazione = inizio lavorazione: zero ore anche quando la fine attrezzaggio registrata è successiva
      // all'inizio lavorazione (orari incoerenti del vecchio sistema).
      if (r.work_started_at && !r.work_ended_at) { r.work_ended_at = r.work_started_at; filled.workEndedAt = (r.work_started_at as Date).toISOString(); }
      r.status = 'COMPLETED';
      this.stats.fix(statsName, from === 'SUSPENDED'
        ? 'fase sospesa e mai ripresa nel vecchio sistema → conclusa (fine = ultimo orario registrato, durata aggiunta zero)'
        : 'fase rimasta in corso nel vecchio sistema → conclusa (fine = ultimo orario registrato, durata aggiunta zero)');
      this.autoClosed.push({ entity: 'work_phase', id: r.id as number, changes: { status: { from, to: 'COMPLETED' }, ...filled } });
    }
  }

  /** Registrazioni rimaste aperte nel vecchio sistema e chiuse dall'import (per il registro modifiche). */
  private autoClosed: { entity: string; id: number; changes: Record<string, unknown> }[] = [];

  /**
   * Fine di un fermo, lavoro extra o collaudo: se manca la registrazione era rimasta aperta nel vecchio sistema
   * e si chiude con fine = inizio (durata zero).
   */
  private closeIfOpen(statsName: string, entity: string, id: number, start: Date, end: Date | null, what: string): Date {
    if (end) return end;
    this.stats.fix(statsName, `${what} rimasto aperto nel vecchio sistema → chiuso (fine = inizio, durata zero)`);
    this.autoClosed.push({ entity, id, changes: { endedAt: start.toISOString() } });
    return start;
  }

  // ---------------------------------------------------------------------------------------------
  // UTENTI E SEGNALAZIONI
  // ---------------------------------------------------------------------------------------------
  private async importUsersAndTickets() {
    const s = this.stats;
    const un = 'utente → app_user';
    const skipUsers = new Set((process.env.LEGACY_SKIP_USERS ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean));
    const companyDomain = (process.env.LEGACY_COMPANY_EMAIL_DOMAIN ?? '').trim().toLowerCase();
    const utenti = await this.q(`SELECT u.*, (SELECT MIN(l.livello) FROM livello_utente_utente lu JOIN livello_utente l ON l.id = lu.idLivelloUtente
      WHERE lu.idUtente = u.id) AS livello FROM utente u ORDER BY u.id`);
    s.read(un, utenti.length);
    for (const u of utenti) {
      const username = String(u.username ?? '').trim();
      if (!username) { s.skip(un, 'username vuoto'); continue; }
      if (skipUsers.has(username.toLowerCase())) { s.skip(un, 'utente escluso (LEGACY_SKIP_USERS)'); continue; }
      const isDeleted = bool(u.deleted);
      const role = username.toLowerCase() === 'tablet' ? 'TABLET' : u.livello === null ? 'OFFICE' : Number(u.livello) === 0 ? 'ADMIN' : 'OFFICE';
      const emailDomain = String(u.email ?? '').split('@')[1]?.trim().toLowerCase() ?? '';
      if (companyDomain && role !== 'TABLET' && emailDomain && emailDomain !== companyDomain) {
        s.skip(un, 'account esterno (email fuori dal dominio aziendale LEGACY_COMPANY_EMAIL_DOMAIN)');
        continue;
      }
      if (u.livello === null && role !== 'TABLET') s.fix(un, 'livello mancante → ufficio');
      const existing = (await this.db.query(
        `SELECT id, password_hash FROM app_user WHERE lower(username) = lower($1) AND (deleted_at IS NULL) = $2 ORDER BY id LIMIT 1`,
        [username, !isDeleted])).rows[0];
      if (existing && (existing.id === 1 || existing.password_hash !== null)) {
        // Utente già presente nel nuovo sistema (o già attivato con una password): non si tocca
        s.skip(un, 'username già presente nel nuovo sistema: lasciato invariato');
        this.userMap.set(u.id, existing.id);
        continue;
      }
      const values = [username, u.nome ?? username, u.cognome ?? '', role === 'TABLET' ? null : text(u.email), role, bool(u.enabled), deletedAt(u.deleted)];
      if (existing) {
        // Già importato da un'esecuzione precedente e mai attivato: si riallinea
        await this.db.query(`UPDATE app_user SET username = $1, first_name = $2, last_name = $3, email = $4, role = $5, enabled = $6,
          deleted_at = $7, must_change_password = true, updated_at = now() WHERE id = $8`, [...values, existing.id]);
        this.userMap.set(u.id, existing.id);
      } else {
        const res = await this.db.query(`INSERT INTO app_user (username, password_hash, first_name, last_name, email, role, enabled,
          must_change_password, deleted_at) VALUES ($1, NULL, $2, $3, $4, $5, $6, true, $7) RETURNING id`, values);
        this.userMap.set(u.id, res.rows[0].id);
      }
      s.imported(un);
    }

    // Segnalazioni
    const tn = 'rail → support_ticket';
    const rail = await this.q('SELECT * FROM rail ORDER BY id');
    s.read(tn, rail.length);
    const prio: Record<string, string> = { '1_BASSA': 'LOW', '2_MEDIA': 'MEDIUM', '3_ALTA': 'HIGH', '4_BLOCCANTE': 'BLOCKING' };
    const stat: Record<string, string> = {
      APERTO: 'OPEN', IN_LAVORAZIONE: 'IN_PROGRESS', DA_VERIFICARE: 'TO_VERIFY', RIFIUTATO: 'REJECTED', RESPINTO: 'REJECTED',
      IN_AGGIORNAMENTO: 'UPDATING', RISOLTO: 'RESOLVED', NON_FATTIBILE: 'NOT_FEASIBLE', NON_REALIZZABILE: 'NOT_FEASIBLE',
      NON_RISCONTRATO: 'NOT_REPRODUCIBLE',
    };
    const tRows: Row[] = [];
    for (const r of rail) {
      const key = (v: unknown) => String(v ?? '').trim().toUpperCase().replace(/^\d+_/, '');
      let priority = prio[String(r.priorita ?? '').trim().toUpperCase()];
      if (!priority) { s.fix(tn, 'priorità sconosciuta → media'); priority = 'MEDIUM'; }
      let status = stat[key(r.stato)];
      if (!status) { s.fix(tn, 'stato sconosciuto → aperta'); status = 'OPEN'; }
      const userId = this.userMap.get(r.idUtente) ?? null;
      if (userId === null) s.fix(tn, 'utente inesistente o non importato → vuoto');
      const created = legacyDateTime(r.data) ?? IMPORT_NOW;
      tRows.push({ id: r.id, code: null, user_id: userId, subject: r.argomento ?? '', priority, description: r.descrizione ?? '',
        suggestion: text(r.suggerimento), feedback: text(r.feedback), status, created_at: created, deleted_at: deletedAt(r.deleted) });
    }
    await this.insert(tn, 'support_ticket', tRows);
  }

  // ---------------------------------------------------------------------------------------------
  // IMPOSTAZIONI
  // ---------------------------------------------------------------------------------------------
  private async importSettings() {
    const s = this.stats;
    const n = 'impostazioni → app_setting';
    const sys = await this.q(`SELECT valore FROM impostazione_sistema WHERE chiave = 'prezzo_minuto_progettazione_cam'`);
    s.read(n, 1);
    if (sys.length) {
      const v = num(String(sys[0].valore ?? '').replace(',', '.')) ?? 0;
      await this.db.query(`UPDATE app_setting SET value = $1::jsonb, updated_at = now() WHERE key = 'cam_price_per_minute'`, [JSON.stringify(v)]);
      s.imported(n);
    } else s.skip(n, 'prezzo minuto CAM assente nel vecchio DB');
  }

  private async countNotImported() {
    for (const [table, reason] of Object.entries(NOT_IMPORTED)) {
      try {
        const [[r]] = (await this.my.query(`SELECT COUNT(*) AS n FROM \`${table}\``)) as any;
        const name = `${table} (non importata)`;
        this.stats.read(name, Number(r.n));
        if (Number(r.n)) this.stats.skip(name, reason, Number(r.n));
      } catch {
        // Tabella assente nella copia del vecchio DB: niente da contare
      }
    }
  }

  /**
   * Il vecchio database contiene un'offerta e un preventivo creati per collaudare il software
   * (codice che termina con "DiProva", senza ordini di produzione): non sono dati dell'officina.
   */
  private async removeTestRecords() {
    const n = 'dati di prova (rimossi)';
    const q = await this.db.query(`DELETE FROM quote WHERE number ~* 'diprova$' RETURNING id`);
    const co = await this.db.query(`DELETE FROM customer_order co WHERE code ~* 'diprova$'
      AND NOT EXISTS (SELECT 1 FROM production_order po WHERE po.customer_order_id = co.id) RETURNING id`);
    const tot = q.rowCount! + co.rowCount!;
    this.stats.read(n, tot);
    if (tot) this.stats.skip(n, 'preventivi/ordini cliente di prova del vecchio software', tot);
  }

  private async resetSequences() {
    for (const t of [...DOMAIN_TABLES, 'app_user']) {
      const col = (await this.db.query(
        `SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'id' AND is_identity = 'YES'`, [t])).rows;
      if (!col.length) continue;
      await this.db.query(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), COALESCE((SELECT MAX(id) FROM ${t}), 0) + 1, false)`);
    }
  }
}

// -------------------------------------------------------------------------------------------------

function mapOrderStatus(v: unknown): string | null {
  return ({ '0': 'TO_DO', '1': 'IN_PROGRESS', '2': 'COMPLETED' } as Record<string, string>)[String(v ?? '').trim()] ?? null;
}

function mapUnit(v: unknown): string | null {
  const s = String(v ?? '').trim().toUpperCase();
  if (s === '0_DM2' || s === 'DM2') return 'DM2';
  if (s === '1_KG' || s === 'KG') return 'KG';
  return null;
}

/** Nome normalizzato per la colonna Excel e i ruoli fissi: maiuscolo, senza accenti né spazi. */
function normalizeName(v: unknown): string {
  return String(v ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}
