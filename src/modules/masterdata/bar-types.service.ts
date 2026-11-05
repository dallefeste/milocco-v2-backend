import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, SelectQueryBuilder } from 'typeorm';
import { BAR_SHAPES } from '../../shared';
import { CrudService } from '../../common/crud/crud.service';
import { ListQueryDto } from '../../common/crud/list-query.dto';
import { BarStock, BarType, Finish, Material } from '../../entities';
import { buildBarCode, normalizeDimensions } from './bar-code';
import { assertNotUsed, plural } from './masterdata.common';
import { CreateBarTypeDto, PreviewBarTypeDto, UpdateBarTypeDto } from './masterdata.dto';

/** Tipologia barra con la sua giacenza (null se mai movimentata). */
export type BarTypeWithStock = BarType & { stock: BarStock | null };

/**
 * Tipologie barre (materie prime). La lista include la giacenza in metri (`stock`):
 * è la stessa usata dalla pagina Magazzino barre (GET /bar-stock).
 */
@Injectable()
export class BarTypesService extends CrudService<BarType> {
  constructor(
    @InjectRepository(BarType) repo: Repository<BarType>,
    @InjectRepository(Material) private readonly materials: Repository<Material>,
    @InjectRepository(Finish) private readonly finishes: Repository<Finish>,
  ) {
    super(repo, {
      label: 'Tipologia barra',
      relations: ['material', 'finish'],
      searchFields: ['code', 'dimensions', 'material.name', 'material.code', 'stock.description'],
      sortable: ['code', 'shape', 'dimensions', 'material.name', 'finish.name', 'stock.meters', 'createdAt'],
      filterable: ['materialId', 'finishId', 'shape'],
      defaultSort: { field: 'code', order: 'asc' },
    });
  }

  protected baseQuery(withDeleted = false): SelectQueryBuilder<BarType> {
    return super.baseQuery(withDeleted).leftJoinAndMapOne(`${this.alias}.stock`, BarStock, 'stock', `stock.barTypeId = ${this.alias}.id`);
  }

  /** filter[stockState] = 'available' (> 0) · 'negative' (< 0) · 'empty' (0 o mai caricata). */
  protected customizeList(qb: SelectQueryBuilder<BarType>, query: ListQueryDto): void {
    switch (query.filter?.stockState) {
      case 'available': qb.andWhere('stock.meters > 0'); break;
      case 'negative': qb.andWhere('stock.meters < 0'); break;
      case 'empty': qb.andWhere('(stock.id IS NULL OR stock.meters = 0)'); break;
    }
  }

  async findWithStock(id: number): Promise<BarTypeWithStock> {
    return (await this.findOne(id)) as BarTypeWithStock;
  }

  /** Calcola il codice da materiale, forma, finitura e dimensioni (con i controlli sui dati). */
  async computeCode(dto: { materialId?: number | null; shape?: string | null; finishId?: number | null; dimensions?: string | null }): Promise<string> {
    if (!dto.materialId) throw new BadRequestException('Scegli il materiale.');
    if (!dto.shape || !BAR_SHAPES[dto.shape]) throw new BadRequestException('Scegli una forma valida.');
    if (!dto.finishId) throw new BadRequestException('Scegli la finitura.');
    const dimensions = normalizeDimensions(dto.dimensions);
    if (!dimensions) throw new BadRequestException('Indica le dimensioni (es. 100X10).');
    const material = await this.materials.findOne({ where: { id: dto.materialId } });
    if (!material) throw new NotFoundException('Materiale non trovato');
    if (!material.code) throw new BadRequestException(`Il materiale "${material.name}" non ha un codice: impostalo in Anagrafiche → Materiali.`);
    const finish = await this.finishes.findOne({ where: { id: dto.finishId } });
    if (!finish) throw new NotFoundException('Finitura non trovata');
    return buildBarCode(material.code, dto.shape, finish.code, dimensions);
  }

  /** Anteprima del codice per il modulo di creazione: codice e tipologia già esistente con lo stesso codice. */
  async preview(dto: PreviewBarTypeDto): Promise<{ code: string | null; existingId: number | null; error: string | null }> {
    try {
      const code = await this.computeCode(dto);
      const existing = await this.repo.findOne({ where: { code } });
      return { code, existingId: existing?.id ?? null, error: null };
    } catch (err) {
      return { code: null, existingId: null, error: (err as Error).message };
    }
  }

  private async assertCodeFree(code: string, exceptId?: number) {
    const existing = await this.repo.findOne({ where: { code } });
    if (existing && existing.id !== exceptId) throw new ConflictException(`Esiste già la tipologia barra ${code}.`);
  }

  async createBarType(dto: CreateBarTypeDto): Promise<BarType> {
    const code = await this.computeCode(dto);
    await this.assertCodeFree(code);
    return this.create({ ...dto, dimensions: normalizeDimensions(dto.dimensions), code });
  }

  async updateBarType(id: number, dto: UpdateBarTypeDto): Promise<BarType> {
    const current = await this.findWithStock(id);
    const merged = {
      materialId: dto.materialId ?? current.materialId,
      shape: dto.shape ?? current.shape,
      finishId: dto.finishId ?? current.finishId,
      dimensions: dto.dimensions ?? current.dimensions,
    };
    const code = await this.computeCode(merged);
    await this.assertCodeFree(code, id);
    return this.update(id, { ...merged, dimensions: normalizeDimensions(merged.dimensions), code });
  }

  async remove(id: number): Promise<void> {
    const current = await this.findWithStock(id);
    await assertNotUsed(this.repo.manager, [{
      sql: 'SELECT 1 FROM part WHERE bar_type_id = $1 AND deleted_at IS NULL',
      params: [id],
      message: (n) => `La tipologia è indicata in ${plural(n, 'particolare', 'particolari')}: non si può eliminare.`,
    }]);
    if (current.stock && Number(current.stock.meters) !== 0) {
      throw new ConflictException(`In magazzino risultano ${current.stock.meters} m di ${current.code}: azzera prima la giacenza con una rettifica.`);
    }
    await super.remove(id);
  }
}
