import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import type { CompletenessStatus } from '../../shared';
import { DataSource, EntityManager, In, Repository, SelectQueryBuilder } from 'typeorm';
import { CrudService, writeAudit } from '../../common/crud/crud.service';
import { ListQueryDto, Paginated } from '../../common/crud/list-query.dto';
import { BarType, MachineType, Material, Part, PartCycleStep } from '../../entities';
import { partToCompleteSql } from './completeness';
import { CreatePartDto, UpdatePartDto, WeightPreviewDto } from './technical.dto';
import { computeWeight, WeightInputError, WEIGHT_SHAPES } from './weight-calculator';

export interface PartListItem extends Part {
  completeness: CompletenessStatus;
  cycleCount: number;
}

/** Particolari: dati tecnici, calcolatore peso, ciclo di lavorazione. */
@Injectable()
export class PartsService extends CrudService<Part> {
  constructor(
    @InjectRepository(Part) repo: Repository<Part>,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {
    super(repo, {
      label: 'Particolare',
      relations: ['material', 'supplier', 'barType'],
      searchFields: ['internalCode', 'name', 'dimensions'],
      sortable: ['internalCode', 'name', 'dimensions', 'weightKg', 'barCut', 'createdAt', 'updatedAt', 'material.name', 'supplier.name', 'barType.code'],
      filterable: ['materialId', 'supplierId', 'barCut', 'barTypeId', 'shape'],
      defaultSort: { field: 'createdAt', order: 'desc' },
    });
  }

  /**
   * Filtri aggiuntivi: `filter[drawingId]` (particolari di un disegno, ognuno una sola volta anche se
   * compare in più posizioni) e `filter[completeness]` = TO_COMPLETE | COMPLETE.
   */
  protected customizeList(qb: SelectQueryBuilder<Part>, query: ListQueryDto): void {
    const f = query.filter ?? {};
    const drawingId = Number(f.drawingId);
    if (f.drawingId && Number.isInteger(drawingId)) {
      qb.andWhere('e.id IN (SELECT dp.part_id FROM drawing_part dp WHERE dp.drawing_id = :drawingId)', { drawingId });
    }
    if (f.completeness === 'TO_COMPLETE') qb.andWhere(partToCompleteSql('e'));
    else if (f.completeness === 'COMPLETE') qb.andWhere(`NOT ${partToCompleteSql('e')}`);
  }

  async list(query: ListQueryDto): Promise<Paginated<PartListItem>> {
    const res = await super.list(query);
    const counts = await this.cycleCounts(res.items.map((p) => p.id));
    return {
      ...res,
      items: res.items.map((p) => {
        const n = counts.get(p.id) ?? 0;
        return Object.assign(p, { cycleCount: n, completeness: (n > 0 ? 'COMPLETE' : 'TO_COMPLETE') as CompletenessStatus });
      }),
    };
  }

  private async cycleCounts(ids: number[]): Promise<Map<number, number>> {
    if (!ids.length) return new Map();
    const rows: { part_id: number; n: string }[] = await this.dataSource.query(
      'SELECT part_id, count(*) AS n FROM part_cycle_step WHERE part_id = ANY($1) GROUP BY part_id',
      [ids],
    );
    return new Map(rows.map((r) => [Number(r.part_id), Number(r.n)]));
  }

  /** Dettaglio con ciclo ordinato per sequenza e disegni che usano il particolare. */
  async detail(id: number) {
    const part = await this.findOne(id, true);
    const cycle = await this.dataSource.getRepository(PartCycleStep).find({
      where: { partId: id },
      relations: { machineType: true },
      order: { sequence: 'ASC', id: 'ASC' },
    });
    const drawings: { id: number; code: string; revision: string; name: string; quantity: number; positions: string }[] = await this.dataSource.query(
      `SELECT d.id, d.code, d.revision, d.name, sum(dp.quantity)::int AS quantity, string_agg(dp.position::text, ', ' ORDER BY dp.position) AS positions
         FROM drawing_part dp JOIN drawing d ON d.id = dp.drawing_id AND d.deleted_at IS NULL
        WHERE dp.part_id = $1
        GROUP BY d.id ORDER BY d.code, d.revision LIMIT 200`,
      [id],
    );
    return {
      ...part,
      cycle,
      completeness: (cycle.length ? 'COMPLETE' : 'TO_COMPLETE') as CompletenessStatus,
      drawings,
    };
  }

  async createPart(dto: CreatePartDto) {
    const id = await this.dataSource.transaction((em) => this.save(em, null, dto));
    return this.detail(id);
  }

  async updatePart(id: number, dto: UpdatePartDto) {
    await this.dataSource.transaction((em) => this.save(em, id, dto));
    return this.detail(id);
  }

  /** Salva dati e ciclo in un'unica transazione, applicando le regole del particolare. */
  private async save(em: EntityManager, id: number | null, dto: CreatePartDto | UpdatePartDto): Promise<number> {
    const repo = em.getRepository(Part);
    let part: Part;
    if (id) {
      const found = await repo.findOne({ where: { id } });
      if (!found) throw new NotFoundException(`Particolare non trovato (id ${id})`);
      part = found;
    } else {
      part = repo.create({ name: '', barCut: false });
    }
    const previousCode = id ? part.internalCode : null;
    const { cycle, ...fields } = dto;
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined) (part as unknown as Record<string, unknown>)[k] = typeof v === 'string' ? v.trim() : v;
    }
    if (!part.internalCode) throw new BadRequestException('Il codice interno del particolare è obbligatorio');
    if (part.dimensions === '') part.dimensions = null;
    if (part.notes === '') part.notes = null;

    // Tipologia barra: obbligatoria con "taglio a barra"; se il materiale è vuoto si usa quello della tipologia.
    if (part.barTypeId) {
      const bt = await em.getRepository(BarType).findOne({ where: { id: part.barTypeId } });
      if (!bt) throw new BadRequestException('La tipologia barra scelta non esiste più.');
      if (!part.materialId && bt.materialId) part.materialId = bt.materialId;
    }
    if (part.barCut && !part.barTypeId) {
      throw new BadRequestException('Per un particolare con "taglio a barra" scegli la tipologia barra da cui si taglia.');
    }

    // Forma del calcolatore peso: misure validate e lunghezza di taglio = L.
    if (dto.shape !== undefined || dto.shapeParams !== undefined) {
      if (part.shape) {
        const material = part.materialId ? await em.getRepository(Material).findOne({ where: { id: part.materialId } }) : null;
        try {
          const r = computeWeight(part.shape, part.shapeParams ?? {}, material?.density);
          part.shapeParams = r.params;
          part.cutLengthMm = r.cutLengthMm;
          if (dto.dimensions === undefined) part.dimensions = r.dimensions;
          if (dto.weightKg === undefined && r.weightKg !== null) part.weightKg = r.weightKg;
        } catch (e) {
          if (e instanceof WeightInputError) throw new BadRequestException(e.message);
          throw e;
        }
      } else {
        part.shapeParams = null;
      }
    }

    // Codice interno univoco (controllato solo se cambia: i dati storici possono avere doppioni).
    const dup = previousCode?.toLowerCase() === part.internalCode.toLowerCase() ? null : await repo
      .createQueryBuilder('p')
      .where('lower(p.internalCode) = lower(:code)', { code: part.internalCode })
      .andWhere(id ? 'p.id <> :id' : '1=1', { id })
      .getOne();
    if (dup) throw new ConflictException(`Esiste già un particolare con codice interno ${dup.internalCode} (id ${dup.id}).`);

    const saved = await repo.save(part);
    if (cycle !== undefined) await this.saveCycle(em, saved.id, cycle);
    await writeAudit(em, 'part', id ? 'UPDATE' : 'CREATE', saved.id, dto, saved.internalCode);
    return saved.id;
  }

  /** Sostituisce il ciclo: le fasi esistenti (con id) si aggiornano, le nuove si inseriscono, le mancanti si eliminano. */
  private async saveCycle(em: EntityManager, partId: number, steps: NonNullable<UpdatePartDto['cycle']>): Promise<void> {
    const typeIds = [...new Set(steps.map((s) => s.machineTypeId))];
    if (typeIds.length) {
      const n = await em.getRepository(MachineType).count({ where: { id: In(typeIds) } });
      if (n !== typeIds.length) throw new BadRequestException('Una delle tipologie macchina del ciclo non esiste più.');
    }
    const stepRepo = em.getRepository(PartCycleStep);
    const existing = await stepRepo.find({ where: { partId } });
    const existingIds = new Set(existing.map((s) => s.id));
    const keep = new Set<number>();
    const rows = steps.map((s, i) => {
      const reuse = s.id && existingIds.has(s.id) && !keep.has(s.id) ? s.id : undefined;
      if (reuse) keep.add(reuse);
      return stepRepo.create({
        id: reuse,
        partId,
        machineTypeId: s.machineTypeId,
        sequence: i + 1,
        setupSeconds: s.setupSeconds,
        unitSeconds: s.unitSeconds,
        plannedManMinutes: s.plannedManMinutes ?? null,
      });
    });
    const toDelete = existing.filter((s) => !keep.has(s.id)).map((s) => s.id);
    if (toDelete.length) await stepRepo.delete({ id: In(toDelete) });
    if (rows.length) await stepRepo.save(rows);
  }

  /** Eliminazione logica, vietata se il particolare compare in disegni non eliminati. */
  async remove(id: number): Promise<void> {
    const part = await this.findOne(id);
    const drawings: { code: string; revision: string }[] = await this.dataSource.query(
      `SELECT DISTINCT d.code, d.revision FROM drawing_part dp JOIN drawing d ON d.id = dp.drawing_id AND d.deleted_at IS NULL
        WHERE dp.part_id = $1 ORDER BY d.code, d.revision LIMIT 10`,
      [id],
    );
    if (drawings.length) {
      const list = drawings.map((d) => (d.revision ? `${d.code}.${d.revision}` : d.code)).join(', ');
      throw new ConflictException(`Il particolare ${part.internalCode} non si può eliminare perché fa parte dei disegni ${list}. Toglilo prima dalla composizione.`);
    }
    await this.dataSource.transaction(async (em) => {
      await em.softDelete(Part, id);
      await writeAudit(em, 'part', 'DELETE', id, undefined, part.internalCode);
    });
  }

  // ------------------------------------------------------------------ calcolatore peso

  shapes() {
    return WEIGHT_SHAPES.map((s) => ({ key: s.key, label: s.label, params: s.params, computesWeight: s.volume !== null }));
  }

  async weightPreview(dto: WeightPreviewDto) {
    let density = dto.density ?? null;
    let materialName: string | null = null;
    if (dto.materialId) {
      const m = await this.dataSource.getRepository(Material).findOne({ where: { id: dto.materialId } });
      if (!m) throw new BadRequestException('Il materiale scelto non esiste più.');
      density = m.density;
      materialName = m.name;
    }
    try {
      return { ...computeWeight(dto.shape, dto.params, density), materialName };
    } catch (e) {
      if (e instanceof WeightInputError) throw new BadRequestException(e.message);
      throw e;
    }
  }
}
