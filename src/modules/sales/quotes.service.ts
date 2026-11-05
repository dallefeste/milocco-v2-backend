import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, IsNull, Repository, SelectQueryBuilder } from 'typeorm';
import type { TreatmentPriceUnit } from '../../shared';
import { CrudService, writeAudit } from '../../common/crud/crud.service';
import { ListQueryDto, Paginated } from '../../common/crud/list-query.dto';
import { Customer, Machine, MachineType, Part, Quote, QuotePart, QuotePartPhase, QuotePartTreatment, Treatment } from '../../entities';
import { SettingsService } from '../settings/settings.service';
import { computePartCost, computeTotals, PartCost, QuoteTotals } from './quote-costs';
import { CreateQuoteDto, CreateQuotePartDto, QuotePartPhaseDto, QuotePartTreatmentDto, UpdateQuoteDto, UpdateQuotePartDto } from './sales.dto';

export interface ProposedPhase {
  machineTypeId: number;
  machineTypeName: string;
  sequence: number;
  programmingSeconds: number;
  setupSeconds: number;
  unitSeconds: number;
  machineId: number | null;
  machineName: string | null;
  machineHourlyRate: number;
  /** Da dove arriva la macchina proposta. */
  machineSource: 'LAST_QUOTE' | 'ONLY_MACHINE' | 'FIRST_MACHINE' | null;
}

export interface ProposedTreatment {
  treatmentId: number;
  name: string;
  unitPrice: number;
  unit: TreatmentPriceUnit;
}

export interface PartProposal {
  part: { id: number; internalCode: string; name: string; materialId: number | null; materialName: string | null; weightKg: number | null; treatmentKg: number | null; treatmentDm2: number | null; dimensions: string | null };
  materialPricePerKg: number;
  camPricePerMinute: number;
  phases: ProposedPhase[];
  treatments: ProposedTreatment[];
  warnings: string[];
}

export interface QuotePartCostRow {
  quotePartId: number;
  partId: number;
  internalCode: string;
  name: string;
  dimensions: string | null;
  materialName: string | null;
  quantity: number;
  productionQuantity: number;
  camSeconds: number;
  camPricePerMinute: number;
  materialPricePerKg: number;
  weightKg: number | null;
  treatmentKg: number | null;
  treatmentDm2: number | null;
  notes: string | null;
  cost: PartCost;
}

export interface QuoteCosts {
  quote: { id: number; number: string; customerId: number; customerName: string; issueDate: string; expectedDeliveryDate: string | null; materialMarkup: number; markup: number };
  parts: QuotePartCostRow[];
  totals: QuoteTotals;
  /** Tempi totali del preventivo per tipologia macchina (lotti completi). */
  timesByMachineType: { machineTypeId: number; machineTypeName: string; programmingSeconds: number; setupSeconds: number; workSeconds: number; totalSeconds: number }[];
  warnings: string[];
}

/** Preventivi: testata, righe particolari con fasi e trattamenti, proposte, costi. Solo amministratori. */
@Injectable()
export class QuotesService extends CrudService<Quote> {
  constructor(
    @InjectRepository(Quote) repo: Repository<Quote>,
    @InjectRepository(QuotePart) private readonly partsRepo: Repository<QuotePart>,
    private readonly dataSource: DataSource,
    private readonly settings: SettingsService,
  ) {
    super(repo, {
      label: 'Preventivo',
      relations: ['customer', 'customerOrder'],
      searchFields: ['number', 'customer.name', 'notes', 'customerOrder.code'],
      sortable: ['number', 'issueDate', 'expectedDeliveryDate', 'customer.name', 'createdAt', 'materialMarkup', 'markup'],
      filterable: ['customerId', 'customerOrderId'],
      defaultSort: { field: 'issueDate', order: 'desc' },
    });
  }

  // ------------------------------------------------------------------ Impostazioni

  async defaults() {
    return {
      camPricePerMinute: Number(await this.settings.get('cam_price_per_minute', 0)) || 0,
      materialMarkup: Number(await this.settings.get('default_material_markup', 1.15)) || 1.15,
      markup: Number(await this.settings.get('default_markup', 1.25)) || 1.25,
    };
  }

  // ------------------------------------------------------------------ Lista e dettaglio

  protected customizeList(qb: SelectQueryBuilder<Quote>, query: ListQueryDto): void {
    const f = query.filter ?? {};
    if (f.from) qb.andWhere('e.issueDate >= :from', { from: f.from });
    if (f.to) qb.andWhere('e.issueDate <= :to', { to: f.to });
    if (f.linked === 'true') qb.andWhere('e.customerOrderId IS NOT NULL');
    if (f.linked === 'false') qb.andWhere('e.customerOrderId IS NULL');
  }

  async list(query: ListQueryDto): Promise<Paginated<Quote & { partsCount: number }>> {
    const res = await super.list(query);
    const ids = res.items.map((q) => q.id);
    const counts = new Map<number, number>();
    if (ids.length) {
      const rows: { quote_id: number; n: string }[] = await this.repo.query(
        'SELECT quote_id, count(*) AS n FROM quote_part WHERE deleted_at IS NULL AND quote_id = ANY($1) GROUP BY quote_id',
        [ids],
      );
      for (const r of rows) counts.set(Number(r.quote_id), Number(r.n));
    }
    return { ...res, items: res.items.map((q) => Object.assign(q, { partsCount: counts.get(q.id) ?? 0 })) };
  }

  /** Preventivo con le righe (particolari, fasi, trattamenti) in ordine. */
  async detail(id: number) {
    const quote = await this.findOne(id);
    const parts = await this.loadParts(this.dataSource.manager, [id]);
    return { ...quote, parts };
  }

  private async loadParts(em: EntityManager, quoteIds: number[]): Promise<QuotePart[]> {
    if (!quoteIds.length) return [];
    const parts = await em.getRepository(QuotePart).find({
      where: { quoteId: In(quoteIds), deletedAt: IsNull() },
      // anche particolari, macchine e trattamenti eliminati dopo il preventivo: lo storico resta leggibile
      withDeleted: true,
      relations: { part: { material: true, supplier: true, barType: true }, phases: { machineType: true, machine: true }, treatments: { treatment: true } },
      order: { sortOrder: 'ASC', id: 'ASC' },
    });
    for (const p of parts) {
      p.phases?.sort((a, b) => a.sequence - b.sequence || a.id - b.id);
      p.treatments?.sort((a, b) => a.id - b.id);
    }
    return parts;
  }

  // ------------------------------------------------------------------ Testata

  private async assertCustomer(em: EntityManager, customerId: number) {
    const c = await em.getRepository(Customer).findOne({ where: { id: customerId } });
    if (!c) throw new BadRequestException('Cliente non trovato');
  }

  async assertNumberFree(em: EntityManager, number: string, exceptId?: number) {
    const rows: { id: number }[] = await em.query(
      'SELECT id FROM quote WHERE deleted_at IS NULL AND lower(trim(number)) = lower(trim($1)) AND ($2::int IS NULL OR id <> $2) LIMIT 1',
      [number, exceptId ?? null],
    );
    if (rows.length) throw new ConflictException(`Esiste già un preventivo con numero "${number.trim()}".`);
  }

  async createQuote(dto: CreateQuoteDto) {
    const d = await this.defaults();
    const id = await this.dataSource.transaction(async (em) => {
      await this.assertCustomer(em, dto.customerId);
      await this.assertNumberFree(em, dto.number);
      const quote = await em.getRepository(Quote).save(
        em.getRepository(Quote).create({
          number: dto.number.trim(),
          customerId: dto.customerId,
          issueDate: dto.issueDate ?? new Date().toISOString().slice(0, 10),
          expectedDeliveryDate: dto.expectedDeliveryDate ?? null,
          materialMarkup: dto.materialMarkup ?? d.materialMarkup,
          markup: dto.markup ?? d.markup,
          notes: dto.notes ?? null,
        }),
      );
      for (const p of dto.parts ?? []) await this.insertPart(em, quote, p);
      await writeAudit(em, 'quote', 'CREATE', quote.id, { ...dto, parts: undefined }, `Preventivo ${quote.number}`);
      return quote.id;
    });
    return this.detail(id);
  }

  async updateQuote(id: number, dto: UpdateQuoteDto) {
    await this.dataSource.transaction(async (em) => {
      const quote = await em.getRepository(Quote).findOne({ where: { id } });
      if (!quote) throw new NotFoundException(`Preventivo non trovato (id ${id})`);
      if (dto.customerId !== undefined) await this.assertCustomer(em, dto.customerId);
      if (dto.number !== undefined) await this.assertNumberFree(em, dto.number, id);
      if (dto.customerOrderId) {
        const rows = await em.query('SELECT id FROM customer_order WHERE id = $1 AND deleted_at IS NULL', [dto.customerOrderId]);
        if (!rows.length) throw new BadRequestException('Ordine cliente non trovato');
      }
      Object.assign(quote, {
        ...(dto.number !== undefined && { number: dto.number.trim() }),
        ...(dto.customerId !== undefined && { customerId: dto.customerId }),
        ...(dto.issueDate !== undefined && { issueDate: dto.issueDate }),
        ...(dto.expectedDeliveryDate !== undefined && { expectedDeliveryDate: dto.expectedDeliveryDate }),
        ...(dto.materialMarkup !== undefined && { materialMarkup: dto.materialMarkup }),
        ...(dto.markup !== undefined && { markup: dto.markup }),
        ...(dto.customerOrderId !== undefined && { customerOrderId: dto.customerOrderId }),
        ...(dto.notes !== undefined && { notes: dto.notes }),
      });
      delete (quote as Partial<Quote>).customer;
      delete (quote as Partial<Quote>).customerOrder;
      await em.getRepository(Quote).save(quote);
      await writeAudit(em, 'quote', 'UPDATE', id, dto);
    });
    return this.detail(id);
  }

  // ------------------------------------------------------------------ Proposte per un particolare

  /** Tariffa oraria da usare: tariffa della macchina per il cliente se presente, altrimenti quella della macchina. */
  async machineRates(em: EntityManager, customerId: number | null, machineIds: number[]): Promise<Map<number, number>> {
    const out = new Map<number, number>();
    if (!machineIds.length) return out;
    const rows: { id: number; rate: string }[] = await em.query(
      `SELECT m.id, COALESCE(cr.hourly_rate, m.hourly_rate) AS rate
         FROM machine m
         LEFT JOIN customer_machine_rate cr ON cr.machine_id = m.id AND cr.customer_id = $2
        WHERE m.id = ANY($1)`,
      [machineIds, customerId],
    );
    for (const r of rows) out.set(Number(r.id), Number(r.rate));
    return out;
  }

  /**
   * Valori proposti quando si aggiunge un particolare (01-commerciale §1.3, con le correzioni):
   * fasi dal ciclo, macchina dal preventivo più recente con lo stesso particolare e tipologia,
   * tariffa dalla macchina, €/kg dal materiale, €/min CAM dalle impostazioni, trattamenti dei disegni.
   */
  async proposal(em: EntityManager, partId: number, opts: { customerId: number | null; excludeQuoteId?: number; fallbackFirstMachine?: boolean }): Promise<PartProposal> {
    const warnings: string[] = [];
    const part = await em.getRepository(Part).findOne({ where: { id: partId }, relations: { material: true } });
    if (!part) throw new BadRequestException(`Particolare non trovato (id ${partId})`);
    const { camPricePerMinute } = await this.defaults();

    const cycle: { machine_type_id: number; name: string; sequence: number; setup_seconds: number; unit_seconds: number }[] = await em.query(
      `SELECT s.machine_type_id, mt.name, s.sequence, s.setup_seconds, s.unit_seconds
         FROM part_cycle_step s JOIN machine_type mt ON mt.id = s.machine_type_id
        WHERE s.part_id = $1 ORDER BY s.sequence, s.id`,
      [partId],
    );
    if (!cycle.length) warnings.push(`Il particolare ${part.internalCode} non ha un ciclo di lavorazione: aggiungi le fasi a mano.`);

    const typeIds = [...new Set(cycle.map((c) => Number(c.machine_type_id)))];
    const machinesByType = await this.machinesByType(em, typeIds);
    const last = await this.lastQuoteMachines(em, partId, typeIds, opts.excludeQuoteId);
    const chosen = new Map<number, { id: number; name: string; source: ProposedPhase['machineSource'] }>();
    for (const t of typeIds) {
      const list = machinesByType.get(t) ?? [];
      const fromQuote = last.get(t);
      if (fromQuote) chosen.set(t, { ...fromQuote, source: 'LAST_QUOTE' });
      else if (list.length === 1) chosen.set(t, { ...list[0], source: 'ONLY_MACHINE' });
      else if (list.length > 1 && opts.fallbackFirstMachine) chosen.set(t, { ...list[0], source: 'FIRST_MACHINE' });
    }
    const rates = await this.machineRates(em, opts.customerId, [...chosen.values()].map((m) => m.id));

    const phases: ProposedPhase[] = cycle.map((c) => {
      const m = chosen.get(Number(c.machine_type_id));
      if (!m) warnings.push(`Fase ${c.name}: scegli la macchina (nessun preventivo precedente con questo particolare).`);
      return {
        machineTypeId: Number(c.machine_type_id),
        machineTypeName: c.name,
        sequence: Number(c.sequence),
        programmingSeconds: 0,
        setupSeconds: Number(c.setup_seconds),
        unitSeconds: Number(c.unit_seconds),
        machineId: m?.id ?? null,
        machineName: m?.name ?? null,
        machineHourlyRate: m ? rates.get(m.id) ?? 0 : 0,
        machineSource: m?.source ?? null,
      };
    });

    const treatments = await this.drawingTreatments(em, partId);
    for (const t of treatments) {
      if (t.unitPrice === null) warnings.push(`Il trattamento "${t.name}" non ha prezzo in anagrafica: inserito a 0, da completare.`);
      if (t.unit === null) warnings.push(`Il trattamento "${t.name}" non ha unità di prezzo in anagrafica: considerato €/kg.`);
    }
    if (!part.materialId) warnings.push(`Il particolare ${part.internalCode} non ha materiale: costo materiale 0.`);
    else if (!part.material?.pricePerKg) warnings.push(`Il materiale ${part.material?.name ?? ''} non ha prezzo €/kg.`);
    if (part.weightKg === null) warnings.push(`Il particolare ${part.internalCode} non ha il peso: costo materiale 0.`);

    return {
      part: {
        id: part.id, internalCode: part.internalCode, name: part.name, materialId: part.materialId, materialName: part.material?.name ?? null,
        weightKg: part.weightKg, treatmentKg: part.treatmentKg, treatmentDm2: part.treatmentDm2, dimensions: part.dimensions,
      },
      materialPricePerKg: part.material?.pricePerKg ?? 0,
      camPricePerMinute,
      phases,
      treatments: treatments.map((t) => ({ treatmentId: t.id, name: t.name, unitPrice: t.unitPrice ?? 0, unit: t.unit ?? 'KG' })),
      warnings: [...new Set(warnings)],
    };
  }

  /** Macchine non eliminate per tipologia, nell'ordine dell'anagrafica. */
  async machinesByType(em: EntityManager, typeIds: number[]): Promise<Map<number, { id: number; name: string }[]>> {
    const out = new Map<number, { id: number; name: string }[]>();
    if (!typeIds.length) return out;
    const rows = await em.getRepository(Machine).find({ where: { machineTypeId: In(typeIds) }, order: { sortOrder: 'ASC', name: 'ASC', id: 'ASC' } });
    for (const m of rows) {
      const list = out.get(m.machineTypeId) ?? [];
      list.push({ id: m.id, name: m.name });
      out.set(m.machineTypeId, list);
    }
    return out;
  }

  /** Macchina usata per ogni tipologia nel preventivo più recente (data di emissione) che contiene il particolare. */
  async lastQuoteMachines(em: EntityManager, partId: number, typeIds: number[], excludeQuoteId?: number) {
    const out = new Map<number, { id: number; name: string }>();
    if (!typeIds.length) return out;
    const rows: { machine_type_id: number; machine_id: number; name: string }[] = await em.query(
      `SELECT DISTINCT ON (f.machine_type_id) f.machine_type_id, f.machine_id, m.name
         FROM quote_part_phase f
         JOIN quote_part qp ON qp.id = f.quote_part_id AND qp.deleted_at IS NULL
         JOIN quote q ON q.id = qp.quote_id AND q.deleted_at IS NULL
         JOIN machine m ON m.id = f.machine_id AND m.deleted_at IS NULL AND m.machine_type_id = f.machine_type_id
        WHERE qp.part_id = $1 AND f.machine_type_id = ANY($2) AND ($3::int IS NULL OR q.id <> $3)
        ORDER BY f.machine_type_id, q.issue_date DESC, q.id DESC, f.id`,
      [partId, typeIds, excludeQuoteId ?? null],
    );
    for (const r of rows) out.set(Number(r.machine_type_id), { id: Number(r.machine_id), name: r.name });
    return out;
  }

  /** Trattamenti di tutti i disegni (non eliminati) che contengono il particolare. */
  async drawingTreatments(em: EntityManager, partId: number): Promise<{ id: number; name: string; unitPrice: number | null; unit: TreatmentPriceUnit | null }[]> {
    const rows: { id: number; name: string; unit_price: string | null; unit: TreatmentPriceUnit | null }[] = await em.query(
      `SELECT DISTINCT t.id, t.name, t.unit_price, t.unit
         FROM drawing_part dp
         JOIN drawing d ON d.id = dp.drawing_id AND d.deleted_at IS NULL
         JOIN drawing_treatment dt ON dt.drawing_id = d.id
         JOIN treatment t ON t.id = dt.treatment_id AND t.deleted_at IS NULL
        WHERE dp.part_id = $1
        ORDER BY t.name, t.id`,
      [partId],
    );
    return rows.map((r) => ({ id: Number(r.id), name: r.name, unitPrice: r.unit_price === null ? null : Number(r.unit_price), unit: r.unit }));
  }

  async proposalFor(quoteId: number, partId: number) {
    const quote = await this.findOne(quoteId);
    return this.proposal(this.dataSource.manager, partId, { customerId: quote.customerId, excludeQuoteId: quoteId });
  }

  /** Tipologie e macchine con la tariffa da usare per il cliente del preventivo (per il pannello delle fasi). */
  async machineOptions(quoteId: number) {
    const quote = await this.findOne(quoteId);
    const em = this.dataSource.manager;
    const types = await em.getRepository(MachineType).find({ order: { sortOrder: 'ASC', name: 'ASC' } });
    const machines = await em.getRepository(Machine).find({ order: { sortOrder: 'ASC', name: 'ASC' } });
    const rates = await this.machineRates(em, quote.customerId, machines.map((m) => m.id));
    const treatments = await em.getRepository(Treatment).find({ order: { name: 'ASC' } });
    return {
      machineTypes: types.map((t) => ({ id: t.id, name: t.name })),
      machines: machines.map((m) => ({ id: m.id, name: m.name, machineTypeId: m.machineTypeId, hourlyRate: rates.get(m.id) ?? m.hourlyRate })),
      treatments: treatments.map((t) => ({ id: t.id, name: t.name, unitPrice: t.unitPrice, unit: t.unit })),
    };
  }

  // ------------------------------------------------------------------ Righe particolari

  private async loadQuote(em: EntityManager, quoteId: number): Promise<Quote> {
    const quote = await em.getRepository(Quote).findOne({ where: { id: quoteId } });
    if (!quote) throw new NotFoundException(`Preventivo non trovato (id ${quoteId})`);
    return quote;
  }

  /** Controlla le fasi e completa la tariffa oraria dalla macchina se non indicata. */
  private async buildPhases(em: EntityManager, quote: Quote, phases: QuotePartPhaseDto[]): Promise<Partial<QuotePartPhase>[]> {
    const machineIds = [...new Set(phases.map((p) => p.machineId).filter((x): x is number => !!x))];
    const machines = machineIds.length ? await em.getRepository(Machine).find({ where: { id: In(machineIds) } }) : [];
    const typeIds = [...new Set(phases.map((p) => p.machineTypeId))];
    const types = typeIds.length ? await em.getRepository(MachineType).find({ where: { id: In(typeIds) } }) : [];
    const rates = await this.machineRates(em, quote.customerId, machineIds);
    return phases.map((p, i) => {
      if (!types.some((t) => t.id === p.machineTypeId)) throw new BadRequestException(`Fase ${i + 1}: tipologia macchina non trovata.`);
      const m = p.machineId ? machines.find((x) => x.id === p.machineId) : null;
      if (p.machineId && !m) throw new BadRequestException(`Fase ${i + 1}: macchina non trovata.`);
      if (m && m.machineTypeId !== p.machineTypeId) {
        throw new BadRequestException(`Fase ${i + 1}: la macchina ${m.name} non è della tipologia scelta.`);
      }
      return {
        machineTypeId: p.machineTypeId,
        machineId: m?.id ?? null,
        sequence: p.sequence ?? i + 1,
        programmingSeconds: p.programmingSeconds ?? 0,
        setupSeconds: p.setupSeconds ?? 0,
        unitSeconds: p.unitSeconds ?? 0,
        machineHourlyRate: p.machineHourlyRate ?? (m ? rates.get(m.id) ?? 0 : 0),
      };
    });
  }

  private async buildTreatments(em: EntityManager, list: QuotePartTreatmentDto[]): Promise<Partial<QuotePartTreatment>[]> {
    const ids = [...new Set(list.map((t) => t.treatmentId))];
    const found = ids.length ? await em.getRepository(Treatment).find({ where: { id: In(ids) } }) : [];
    return list.map((t) => {
      const reg = found.find((x) => x.id === t.treatmentId);
      if (!reg) throw new BadRequestException(`Trattamento non trovato (id ${t.treatmentId}).`);
      return { treatmentId: t.treatmentId, unitPrice: t.unitPrice ?? reg.unitPrice ?? 0, unit: t.unit ?? reg.unit ?? 'KG' };
    });
  }

  /** Inserisce una riga particolare (con le proposte per i dati non indicati). Usata anche dall'import Excel. */
  async insertPart(em: EntityManager, quote: Quote, dto: CreateQuotePartDto, proposal?: PartProposal): Promise<{ id: number; warnings: string[] }> {
    const prop = proposal ?? (await this.proposal(em, dto.partId, { customerId: quote.customerId, excludeQuoteId: quote.id }));
    const phases = dto.phases ? await this.buildPhases(em, quote, dto.phases) : prop.phases.map((p) => ({
      machineTypeId: p.machineTypeId, machineId: p.machineId, sequence: p.sequence, programmingSeconds: p.programmingSeconds,
      setupSeconds: p.setupSeconds, unitSeconds: p.unitSeconds, machineHourlyRate: p.machineHourlyRate,
    }));
    const treatments = dto.treatments
      ? await this.buildTreatments(em, dto.treatments)
      : prop.treatments.map((t) => ({ treatmentId: t.treatmentId, unitPrice: t.unitPrice, unit: t.unit }));
    const maxRow: { m: number | null }[] = await em.query('SELECT max(sort_order) AS m FROM quote_part WHERE quote_id = $1 AND deleted_at IS NULL', [quote.id]);
    const repo = em.getRepository(QuotePart);
    const saved = await repo.save(
      repo.create({
        quoteId: quote.id,
        partId: dto.partId,
        quantity: dto.quantity,
        productionQuantity: dto.productionQuantity,
        camSeconds: dto.camSeconds ?? 0,
        camPricePerMinute: dto.camPricePerMinute ?? prop.camPricePerMinute,
        materialPricePerKg: dto.materialPricePerKg ?? prop.materialPricePerKg,
        weightKg: prop.part.weightKg,
        treatmentKg: prop.part.treatmentKg,
        treatmentDm2: prop.part.treatmentDm2,
        notes: dto.notes ?? null,
        sortOrder: dto.sortOrder ?? Number(maxRow[0]?.m ?? 0) + 1,
      }),
    );
    if (phases.length) await em.getRepository(QuotePartPhase).save(phases.map((p) => ({ ...p, quotePartId: saved.id })));
    if (treatments.length) await em.getRepository(QuotePartTreatment).save(treatments.map((t) => ({ ...t, quotePartId: saved.id })));
    const warnings = dto.phases && dto.treatments ? [] : prop.warnings;
    return { id: saved.id, warnings };
  }

  async createPart(quoteId: number, dto: CreateQuotePartDto) {
    const res = await this.dataSource.transaction(async (em) => {
      const quote = await this.loadQuote(em, quoteId);
      const r = await this.insertPart(em, quote, dto);
      await writeAudit(em, 'quote_part', 'CREATE', r.id, dto, `Particolare aggiunto al preventivo ${quote.number}`);
      return r;
    });
    const parts = await this.loadParts(this.dataSource.manager, [quoteId]);
    return { ...parts.find((p) => p.id === res.id), warnings: res.warnings };
  }

  async updatePart(quoteId: number, rowId: number, dto: UpdateQuotePartDto) {
    await this.dataSource.transaction(async (em) => {
      const quote = await this.loadQuote(em, quoteId);
      const repo = em.getRepository(QuotePart);
      const row = await repo.findOne({ where: { id: rowId, quoteId } });
      if (!row) throw new NotFoundException('Riga del preventivo non trovata');
      const { phases, treatments, refreshSnapshot, ...fields } = dto;
      Object.assign(row, Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)));
      if (refreshSnapshot) {
        const part = await em.getRepository(Part).findOne({ where: { id: row.partId }, withDeleted: true });
        if (part) Object.assign(row, { weightKg: part.weightKg, treatmentKg: part.treatmentKg, treatmentDm2: part.treatmentDm2 });
      }
      await repo.save(row);
      if (phases) {
        const built = await this.buildPhases(em, quote, phases);
        await em.getRepository(QuotePartPhase).delete({ quotePartId: rowId });
        if (built.length) await em.getRepository(QuotePartPhase).save(built.map((p) => ({ ...p, quotePartId: rowId })));
      }
      if (treatments) {
        const built = await this.buildTreatments(em, treatments);
        await em.getRepository(QuotePartTreatment).delete({ quotePartId: rowId });
        if (built.length) await em.getRepository(QuotePartTreatment).save(built.map((t) => ({ ...t, quotePartId: rowId })));
      }
      await writeAudit(em, 'quote_part', 'UPDATE', rowId, dto, `Riga del preventivo ${quote.number}`);
    });
    const parts = await this.loadParts(this.dataSource.manager, [quoteId]);
    return parts.find((p) => p.id === rowId);
  }

  async removePart(quoteId: number, rowId: number) {
    await this.dataSource.transaction(async (em) => {
      const row = await em.getRepository(QuotePart).findOne({ where: { id: rowId, quoteId } });
      if (!row) throw new NotFoundException('Riga del preventivo non trovata');
      await em.getRepository(QuotePart).softDelete(rowId);
      await writeAudit(em, 'quote_part', 'DELETE', rowId, { quoteId, partId: row.partId });
    });
  }

  listParts(quoteId: number) {
    return this.findOne(quoteId).then(() => this.loadParts(this.dataSource.manager, [quoteId]));
  }

  // ------------------------------------------------------------------ Costi

  async costs(id: number): Promise<QuoteCosts> {
    const quote = await this.findOne(id);
    const parts = await this.loadParts(this.dataSource.manager, [id]);
    return this.computeCosts(quote, parts);
  }

  computeCosts(quote: Quote, parts: QuotePart[]): QuoteCosts {
    const markups = { materialMarkup: quote.materialMarkup, markup: quote.markup };
    const rows: QuotePartCostRow[] = parts.map((p) => ({
      quotePartId: p.id,
      partId: p.partId,
      internalCode: p.part?.internalCode ?? `#${p.partId}`,
      name: p.part?.name ?? '',
      dimensions: p.part?.dimensions ?? null,
      materialName: p.part?.material?.name ?? null,
      quantity: p.quantity,
      productionQuantity: p.productionQuantity,
      camSeconds: p.camSeconds,
      camPricePerMinute: p.camPricePerMinute,
      materialPricePerKg: p.materialPricePerKg,
      weightKg: p.weightKg,
      treatmentKg: p.treatmentKg,
      treatmentDm2: p.treatmentDm2,
      notes: p.notes,
      cost: computePartCost(
        {
          productionQuantity: p.productionQuantity,
          camSeconds: p.camSeconds,
          camPricePerMinute: p.camPricePerMinute,
          materialPricePerKg: p.materialPricePerKg,
          weightKg: p.weightKg,
          treatmentKg: p.treatmentKg,
          treatmentDm2: p.treatmentDm2,
          phases: (p.phases ?? []).map((f) => ({
            id: f.id, machineTypeId: f.machineTypeId, machineTypeName: f.machineType?.name, machineId: f.machineId, machineName: f.machine?.name ?? null,
            programmingSeconds: f.programmingSeconds, setupSeconds: f.setupSeconds, unitSeconds: f.unitSeconds, machineHourlyRate: f.machineHourlyRate,
          })),
          treatments: (p.treatments ?? []).map((t) => ({ id: t.id, treatmentId: t.treatmentId, treatmentName: t.treatment?.name, unitPrice: t.unitPrice, unit: t.unit })),
        },
        markups,
      ),
    }));
    const byType = new Map<number, QuoteCosts['timesByMachineType'][number]>();
    for (const r of rows) {
      for (const f of r.cost.phases) {
        const t = byType.get(f.machineTypeId) ?? { machineTypeId: f.machineTypeId, machineTypeName: f.machineTypeName ?? '', programmingSeconds: 0, setupSeconds: 0, workSeconds: 0, totalSeconds: 0 };
        t.programmingSeconds += f.programmingSeconds;
        t.setupSeconds += f.setupSeconds;
        t.workSeconds += f.unitSeconds * Math.max(0, r.productionQuantity);
        t.totalSeconds += f.totalSeconds;
        byType.set(f.machineTypeId, t);
      }
    }
    const warnings = rows.flatMap((r) => r.cost.warnings.map((w) => `${r.internalCode}: ${w}`));
    for (const r of rows) {
      for (const f of r.cost.phases) {
        if (!f.machineId) warnings.push(`${r.internalCode}: fase ${f.machineTypeName ?? ''} senza macchina.`);
      }
    }
    return {
      quote: {
        id: quote.id, number: quote.number, customerId: quote.customerId, customerName: quote.customer?.name ?? '', issueDate: quote.issueDate,
        expectedDeliveryDate: quote.expectedDeliveryDate, materialMarkup: quote.materialMarkup, markup: quote.markup,
      },
      parts: rows,
      totals: computeTotals(rows.map((r) => ({ productionQuantity: r.productionQuantity, cost: r.cost }))),
      timesByMachineType: [...byType.values()],
      warnings,
    };
  }

  /** Dati completi per l'export Excel. */
  async exportData(id: number) {
    const quote = await this.findOne(id);
    const parts = await this.loadParts(this.dataSource.manager, [id]);
    return { quote, parts, costs: this.computeCosts(quote, parts) };
  }
}
