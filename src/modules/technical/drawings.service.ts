import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import type { CompletenessStatus } from '../../shared';
import { Brackets, DataSource, EntityManager, In, Repository, SelectQueryBuilder } from 'typeorm';
import { CrudService, writeAudit } from '../../common/crud/crud.service';
import { ListQueryDto, Paginated } from '../../common/crud/list-query.dto';
import { Drawing, DrawingPart, Part, PartCycleStep, Treatment } from '../../entities';
import { partInternalCode } from '../sales/part-code';
import { drawingToCompleteSql } from './completeness';
import { CreateDrawingDto, UpdateDrawingDto } from './technical.dto';

export interface DrawingListItem extends Drawing {
  completeness: CompletenessStatus;
  partsCount: number;
  partsToComplete: number;
}

/** Disegni: composizione (particolari), trattamenti esterni, stato di compilazione. */
@Injectable()
export class DrawingsService extends CrudService<Drawing> {
  constructor(
    @InjectRepository(Drawing) repo: Repository<Drawing>,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {
    super(repo, {
      label: 'Disegno',
      // ricerca libera gestita in customizeList (accetta anche "codice.revisione")
      searchFields: [],
      sortable: ['code', 'revision', 'name', 'createdAt', 'updatedAt'],
      filterable: ['code', 'revision'],
      defaultSort: { field: 'createdAt', order: 'desc' },
    });
  }

  /**
   * Filtri aggiuntivi (query string `filter[...]`):
   * - completeness = TO_COMPLETE | COMPLETE;
   * - customerOrderId = disegni presenti nelle righe (non eliminate) di un ordine cliente;
   * - partId = disegni che contengono un particolare.
   * Ricerca libera su codice, denominazione e "codice.revisione" / "codice revisione".
   */
  protected customizeList(qb: SelectQueryBuilder<Drawing>, query: ListQueryDto): void {
    const f = query.filter ?? {};
    if (f.completeness === 'TO_COMPLETE') qb.andWhere(drawingToCompleteSql('e'));
    else if (f.completeness === 'COMPLETE') qb.andWhere(`NOT ${drawingToCompleteSql('e')}`);
    const coId = Number(f.customerOrderId);
    if (f.customerOrderId && Number.isInteger(coId)) {
      qb.andWhere(
        'e.id IN (SELECT l.drawing_id FROM customer_order_line l WHERE l.customer_order_id = :coId AND l.deleted_at IS NULL)',
        { coId },
      );
    }
    const partId = Number(f.partId);
    if (f.partId && Number.isInteger(partId)) {
      qb.andWhere('e.id IN (SELECT dp.drawing_id FROM drawing_part dp WHERE dp.part_id = :partId)', { partId });
    }
    const search = query.search?.trim();
    if (search) {
      qb.andWhere(
        new Brackets((w) => {
          w.where('e.code ILIKE :dsearch')
            .orWhere('e.name ILIKE :dsearch')
            .orWhere("(e.code || '.' || e.revision) ILIKE :dsearch")
            .orWhere("(e.code || ' ' || e.revision) ILIKE :dsearch");
        }),
        { dsearch: `%${search}%` },
      );
    }
  }

  async list(query: ListQueryDto): Promise<Paginated<DrawingListItem>> {
    const res = await super.list(query);
    const stats = await this.stats(res.items.map((d) => d.id));
    return { ...res, items: res.items.map((d) => this.withStats(d, stats.get(d.id))) };
  }

  /** Disegni da compilare (stessi filtri della lista). */
  listIncomplete(query: ListQueryDto): Promise<Paginated<DrawingListItem>> {
    return this.list({ ...query, filter: { ...(query.filter ?? {}), completeness: 'TO_COMPLETE' } });
  }

  /**
   * Numero di disegni (non eliminati) da compilare. Usato dal cruscotto e dal badge del menu.
   * Con `customerOrderId` conta solo i disegni delle righe di quell'ordine cliente.
   */
  async countToComplete(options: { customerOrderId?: number } = {}): Promise<number> {
    const qb = this.repo.createQueryBuilder('e').where(drawingToCompleteSql('e'));
    if (options.customerOrderId) {
      qb.andWhere(
        'e.id IN (SELECT l.drawing_id FROM customer_order_line l WHERE l.customer_order_id = :coId AND l.deleted_at IS NULL)',
        { coId: options.customerOrderId },
      );
    }
    return qb.getCount();
  }

  /** Stato di compilazione di più disegni in una query (per altre aree, es. ordini cliente). */
  async completenessOf(drawingIds: number[]): Promise<Map<number, CompletenessStatus>> {
    const stats = await this.stats(drawingIds);
    return new Map(drawingIds.map((id) => [id, this.statusFrom(stats.get(id))]));
  }

  private async stats(ids: number[]): Promise<Map<number, { partsCount: number; partsToComplete: number }>> {
    const out = new Map<number, { partsCount: number; partsToComplete: number }>();
    if (ids.length === 0) return out;
    const rows: { drawing_id: number; parts_count: string; parts_to_complete: string }[] = await this.dataSource.query(
      `SELECT dp.drawing_id,
              count(DISTINCT dp.part_id) AS parts_count,
              count(DISTINCT dp.part_id) FILTER (WHERE NOT EXISTS (SELECT 1 FROM part_cycle_step s WHERE s.part_id = dp.part_id)) AS parts_to_complete
         FROM drawing_part dp
        WHERE dp.drawing_id = ANY($1)
        GROUP BY dp.drawing_id`,
      [ids],
    );
    for (const r of rows) out.set(Number(r.drawing_id), { partsCount: Number(r.parts_count), partsToComplete: Number(r.parts_to_complete) });
    return out;
  }

  private statusFrom(s?: { partsCount: number; partsToComplete: number }): CompletenessStatus {
    return !s || s.partsCount === 0 || s.partsToComplete > 0 ? 'TO_COMPLETE' : 'COMPLETE';
  }

  private withStats(d: Drawing, s?: { partsCount: number; partsToComplete: number }): DrawingListItem {
    return Object.assign(d, {
      completeness: this.statusFrom(s),
      partsCount: s?.partsCount ?? 0,
      partsToComplete: s?.partsToComplete ?? 0,
    });
  }

  /**
   * Dettaglio: dati, trattamenti, composizione ordinata per posizione con i particolari completi
   * (materiale, fornitore, tipologia barra, ciclo) e il loro stato, conteggi degli ordini collegati.
   */
  async detail(id: number) {
    const drawing = await this.repo.findOne({ where: { id }, relations: { treatments: true }, withDeleted: true });
    if (!drawing) throw new NotFoundException(`Disegno non trovato (id ${id})`);

    const lines = await this.dataSource
      .getRepository(DrawingPart)
      .createQueryBuilder('dp')
      .leftJoinAndSelect('dp.part', 'p')
      .leftJoinAndSelect('p.material', 'm')
      .leftJoinAndSelect('p.supplier', 's')
      .leftJoinAndSelect('p.barType', 'bt')
      .withDeleted()
      .where('dp.drawingId = :id', { id })
      .orderBy('dp.position', 'ASC')
      .addOrderBy('dp.id', 'ASC')
      .getMany();

    const partIds = [...new Set(lines.map((l) => l.partId))];
    const steps = partIds.length
      ? await this.dataSource.getRepository(PartCycleStep).find({
          where: { partId: In(partIds) },
          relations: { machineType: true },
          order: { sequence: 'ASC', id: 'ASC' },
        })
      : [];
    const byPart = new Map<number, PartCycleStep[]>();
    for (const s of steps) byPart.set(s.partId, [...(byPart.get(s.partId) ?? []), s]);

    const parts = lines.map((l) => {
      const cycle = byPart.get(l.partId) ?? [];
      return {
        ...l,
        part: l.part ? { ...l.part, cycle, completeness: (cycle.length ? 'COMPLETE' : 'TO_COMPLETE') as CompletenessStatus } : null,
      };
    });
    const distinct = new Map(parts.map((l) => [l.partId, l.part?.completeness]));
    const partsToComplete = [...distinct.values()].filter((c) => c !== 'COMPLETE').length;

    const [usage] = await this.dataSource.query(
      `SELECT
         (SELECT count(*) FROM production_order po WHERE po.drawing_id = $1 AND po.deleted_at IS NULL) AS production_orders,
         (SELECT count(*) FROM production_order po WHERE po.drawing_id = $1 AND po.deleted_at IS NULL AND po.status <> 'COMPLETED') AS open_production_orders,
         (SELECT count(DISTINCT l.customer_order_id) FROM customer_order_line l JOIN customer_order co ON co.id = l.customer_order_id
           WHERE l.drawing_id = $1 AND l.deleted_at IS NULL AND co.deleted_at IS NULL) AS customer_orders`,
      [id],
    );

    return {
      ...drawing,
      parts,
      partsCount: distinct.size,
      partsToComplete,
      completeness: (distinct.size === 0 || partsToComplete > 0 ? 'TO_COMPLETE' : 'COMPLETE') as CompletenessStatus,
      productionOrdersCount: Number(usage.production_orders),
      openProductionOrdersCount: Number(usage.open_production_orders),
      customerOrdersCount: Number(usage.customer_orders),
    };
  }

  async createDrawing(dto: CreateDrawingDto) {
    const id = await this.dataSource.transaction((em) => this.save(em, null, dto));
    return this.detail(id);
  }

  async updateDrawing(id: number, dto: UpdateDrawingDto) {
    await this.dataSource.transaction((em) => this.save(em, id, dto));
    return this.detail(id);
  }

  /** Salva dati, composizione e trattamenti in un'unica transazione. */
  private async save(em: EntityManager, id: number | null, dto: CreateDrawingDto | UpdateDrawingDto): Promise<number> {
    const repo = em.getRepository(Drawing);
    let drawing: Drawing;
    if (id) {
      const found = await repo.findOne({ where: { id } });
      if (!found) throw new NotFoundException(`Disegno non trovato (id ${id})`);
      drawing = found;
    } else {
      drawing = repo.create({ revision: '', name: '' });
    }
    const previousKey = id ? `${drawing.code.toLowerCase()}|${drawing.revision}` : null;
    if (dto.code !== undefined) drawing.code = dto.code.trim();
    if (dto.revision !== undefined) drawing.revision = (dto.revision ?? '').trim();
    if (dto.name !== undefined) drawing.name = (dto.name ?? '').trim();
    if (dto.notes !== undefined) drawing.notes = dto.notes?.trim() || null;
    if (!drawing.code) throw new BadRequestException('Il codice del disegno è obbligatorio');

    // Codice + revisione univoci (controllati solo se cambiano: i dati storici possono avere doppioni).
    const unchanged = previousKey === `${drawing.code.toLowerCase()}|${drawing.revision}`;
    const dup = unchanged ? null : await repo
      .createQueryBuilder('d')
      .where('lower(d.code) = lower(:code) AND d.revision = :rev', { code: drawing.code, rev: drawing.revision })
      .andWhere(id ? 'd.id <> :id' : '1=1', { id })
      .getOne();
    if (dup) {
      throw new ConflictException(
        `Esiste già il disegno ${dup.code}${dup.revision ? ` revisione ${dup.revision}` : ''} (id ${dup.id}): cambia codice o revisione.`,
      );
    }
    const saved = await repo.save(drawing);

    if (!id && 'withPart' in dto && dto.withPart && dto.parts === undefined) {
      // Particolare omonimo del disegno: quello esistente con lo stesso codice interno, altrimenti uno nuovo.
      const internalCode = partInternalCode(saved.code, saved.revision);
      const partRepo = em.getRepository(Part);
      let part = await partRepo.createQueryBuilder('p').where('lower(p.internalCode) = lower(:code)', { code: internalCode }).getOne();
      if (!part) {
        part = await partRepo.save(partRepo.create({ internalCode, name: saved.name }));
        await writeAudit(em, 'part', 'CREATE', part.id, { internalCode, name: saved.name }, `${internalCode} (creato con il disegno)`);
      }
      await em.save(DrawingPart, em.create(DrawingPart, { drawingId: saved.id, partId: part.id, quantity: 1, position: 1 }));
    }

    if (dto.parts !== undefined) {
      const partIds = [...new Set(dto.parts.map((p) => p.partId))];
      const existing = await em.getRepository(DrawingPart).find({ where: { drawingId: saved.id } });
      const alreadyIn = new Set(existing.map((e) => e.partId));
      const found = partIds.length ? await em.getRepository(Part).find({ where: { id: In(partIds) }, withDeleted: true }) : [];
      const byId = new Map(found.map((p) => [p.id, p]));
      for (const pid of partIds) {
        const p = byId.get(pid);
        if (!p) throw new BadRequestException(`Particolare non trovato (id ${pid})`);
        if (p.deletedAt && !alreadyIn.has(pid)) throw new BadRequestException(`Il particolare ${p.internalCode} è stato eliminato e non si può aggiungere.`);
      }
      await em.delete(DrawingPart, { drawingId: saved.id });
      let next = Math.max(0, ...dto.parts.map((p) => p.position ?? 0)) + 1;
      const rows = dto.parts.map((p) =>
        em.create(DrawingPart, { drawingId: saved.id, partId: p.partId, quantity: p.quantity, position: p.position ?? next++ }),
      );
      if (rows.length) await em.save(DrawingPart, rows);
    }

    if (dto.treatmentIds !== undefined) {
      const ids = [...new Set(dto.treatmentIds)];
      if (ids.length) {
        const count = await em.getRepository(Treatment).count({ where: { id: In(ids) } });
        if (count !== ids.length) throw new BadRequestException('Uno dei trattamenti scelti non esiste più.');
      }
      await em.query('DELETE FROM drawing_treatment WHERE drawing_id = $1', [saved.id]);
      for (const tid of ids) await em.query('INSERT INTO drawing_treatment (drawing_id, treatment_id) VALUES ($1, $2)', [saved.id, tid]);
    }

    await writeAudit(em, 'drawing', id ? 'UPDATE' : 'CREATE', saved.id, dto, `${saved.code}${saved.revision ? '.' + saved.revision : ''}`);
    return saved.id;
  }

  /** Eliminazione logica, vietata se il disegno è usato da ordini cliente da confermare o ordini di produzione non completati. */
  async remove(id: number): Promise<void> {
    const drawing = await this.findOne(id);
    const customerOrders: { code: string }[] = await this.dataSource.query(
      `SELECT DISTINCT co.code FROM customer_order_line l JOIN customer_order co ON co.id = l.customer_order_id
        WHERE l.drawing_id = $1 AND l.deleted_at IS NULL AND co.deleted_at IS NULL AND l.status = 'PENDING'
        ORDER BY co.code LIMIT 10`,
      [id],
    );
    const productionOrders: { id: number }[] = await this.dataSource.query(
      `SELECT id FROM production_order WHERE drawing_id = $1 AND deleted_at IS NULL AND status <> 'COMPLETED' ORDER BY id LIMIT 10`,
      [id],
    );
    const reasons: string[] = [];
    if (customerOrders.length) reasons.push(`ordini cliente da confermare ${customerOrders.map((r) => r.code).join(', ')}`);
    if (productionOrders.length) reasons.push(`ordini di produzione non completati n. ${productionOrders.map((r) => r.id).join(', ')}`);
    if (reasons.length) {
      throw new ConflictException(`Il disegno ${drawing.code} non si può eliminare perché è usato da ${reasons.join(' e da ')}.`);
    }
    await this.dataSource.transaction(async (em) => {
      await em.softDelete(Drawing, id);
      await writeAudit(em, 'drawing', 'DELETE', id, undefined, `${drawing.code}${drawing.revision ? '.' + drawing.revision : ''}`);
    });
  }
}
