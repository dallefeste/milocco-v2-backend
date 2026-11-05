import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { fromZonedTime } from 'date-fns-tz';
import { DataSource } from 'typeorm';
import { writeAudit } from '../../../common/crud/crud.service';
import { ListQueryDto } from '../../../common/crud/list-query.dto';
import { CutQueueItem } from '../../../entities';
import { lockQueue, renumberCutQueue, todayIn } from '../common/production-db';
import { computeCutAvailability, provisionalPosition, splitDimensions } from '../common/queue-rules';
import { addDays } from '../planning/schedule-plan';

/** Il particolare ha nel ciclo una fase di una tipologia "taglio". */
const HAS_CUTTING_SQL = `EXISTS (SELECT 1 FROM part_cycle_step pcs JOIN machine_type mt ON mt.id = pcs.machine_type_id
  WHERE pcs.part_id = pop.part_id AND mt.is_cutting AND mt.deleted_at IS NULL)`;

/** Particolari candidati all'approvazione: ordine non completato e non eliminato, fase di taglio nel ciclo. */
const CANDIDATE_SQL = `po.deleted_at IS NULL AND po.status <> 'COMPLETED' AND ${HAS_CUTTING_SQL}`;

const SORTS: Record<string, string> = {
  expectedDeliveryDate: 'po.expected_delivery_date',
  productionOrderId: 'po.id',
  customerName: 'c.name',
  customerOrderCode: 'co.code',
  partCode: 'p.internal_code',
  materialName: 'mat.name',
};

@Injectable()
export class CutService {
  private readonly timeZone: string;

  constructor(@InjectDataSource() private readonly dataSource: DataSource, config: ConfigService) {
    this.timeZone = config.get<string>('timezone') ?? 'Europe/Rome';
  }

  // ---------------------------------------------------------------------------
  // Approvazione
  // ---------------------------------------------------------------------------

  /** Particolari da approvare per il taglio (status NONE) o esclusi (IGNORED), con le colonne di 02-produzione §5.3. */
  async approvalList(q: ListQueryDto, cutStatus: 'NONE' | 'IGNORED') {
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 50;
    const params: unknown[] = [cutStatus];
    const where = [`pop.cut_status = $1`, CANDIDATE_SQL];
    if (q.search?.trim()) {
      params.push(`%${q.search.trim()}%`);
      const i = params.length;
      where.push(`(p.internal_code ILIKE $${i} OR p.name ILIKE $${i} OR c.name ILIKE $${i} OR co.code ILIKE $${i} OR po.id::text = btrim($${i}, '%') OR mat.name ILIKE $${i} OR p.dimensions ILIKE $${i})`);
    }
    const f = q.filter ?? {};
    if (f.customerId) { params.push(Number(f.customerId)); where.push(`co.customer_id = $${params.length}`); }
    if (f.productionOrderId) { params.push(Number(f.productionOrderId)); where.push(`po.id = $${params.length}`); }
    const sort = q.sort && SORTS[q.sort] ? `${SORTS[q.sort]} ${q.order === 'desc' ? 'DESC' : 'ASC'} NULLS LAST` : 'po.expected_delivery_date ASC NULLS LAST';
    const from = `FROM production_order_part pop
      JOIN production_order po ON po.id = pop.production_order_id
      JOIN part p ON p.id = pop.part_id
      LEFT JOIN material mat ON mat.id = p.material_id
      LEFT JOIN bar_type bt ON bt.id = p.bar_type_id
      LEFT JOIN customer_order co ON co.id = po.customer_order_id
      LEFT JOIN customer c ON c.id = co.customer_id
      WHERE ${where.join(' AND ')}`;
    const [{ total }] = await this.dataSource.query(`SELECT COUNT(*)::int AS total ${from}`, params);
    const rows: any[] = await this.dataSource.query(
      `SELECT pop.id, pop.production_order_id, pop.part_id, pop.quantity_per_unit, pop.cut_status, pop.updated_at,
              po.quantity AS order_quantity, po.expected_delivery_date::text AS expected_delivery_date, po.status AS order_status,
              c.id AS customer_id, c.name AS customer_name, co.id AS customer_order_id, co.code AS customer_order_code,
              p.internal_code, p.name AS part_name, p.dimensions, p.cut_length_mm, mat.name AS material_name, bt.code AS bar_type_code
         ${from} ORDER BY ${sort}, po.id, pop.id LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
      params,
    );
    const items = rows.map((r) => {
      const { shape, size } = splitDimensions(r.dimensions);
      return {
        id: r.id,
        productionOrderId: r.production_order_id,
        orderStatus: r.order_status,
        customerId: r.customer_id,
        customerName: r.customer_name,
        customerOrderId: r.customer_order_id,
        customerOrderCode: r.customer_order_code,
        partId: r.part_id,
        partCode: r.internal_code,
        partName: r.part_name,
        dimensions: r.dimensions,
        shape,
        size,
        cutLengthMm: r.cut_length_mm == null ? null : Number(r.cut_length_mm),
        materialName: r.material_name,
        barTypeCode: r.bar_type_code,
        orderQuantity: r.order_quantity,
        quantityPerUnit: r.quantity_per_unit,
        totalQuantity: r.order_quantity * r.quantity_per_unit,
        expectedDeliveryDate: r.expected_delivery_date,
        cutStatus: r.cut_status,
        updatedAt: r.updated_at,
      };
    });
    return { items, total, page, pageSize };
  }

  /** Approva: crea le righe in fondo alla coda di taglio (senza doppioni) e segna i particolari come approvati. */
  async approve(ids: number[]) {
    return this.dataSource.transaction(async (em) => {
      await lockQueue(em, 'cut');
      const rows: { id: number; production_order_id: number; part_id: number }[] = await em.query(
        `SELECT pop.id, pop.production_order_id, pop.part_id
           FROM production_order_part pop JOIN production_order po ON po.id = pop.production_order_id
          WHERE pop.id = ANY($1) AND pop.cut_status = 'NONE' AND ${CANDIDATE_SQL}
            AND NOT EXISTS (SELECT 1 FROM cut_queue_item c WHERE c.production_order_part_id = pop.id AND c.deleted_at IS NULL AND c.status <> 'COMPLETED')
          FOR UPDATE OF pop`,
        [ids],
      );
      const byId = new Map(rows.map((r) => [r.id, r]));
      const ordered = ids.map((id) => byId.get(id)).filter((r): r is NonNullable<typeof r> => !!r);
      const unique = [...new Map(ordered.map((r) => [r.id, r])).values()];
      await renumberCutQueue(em);
      const [{ max }] = await em.query(
        `SELECT COALESCE(MAX(ci.position), 0)::float AS max FROM cut_queue_item ci JOIN production_order po ON po.id = ci.production_order_id
          WHERE ci.deleted_at IS NULL AND po.deleted_at IS NULL AND ci.status <> 'COMPLETED'`,
      );
      let pos = Number(max);
      const created: number[] = [];
      for (const r of unique) {
        const saved = await em.save(
          em.create(CutQueueItem, { productionOrderId: r.production_order_id, productionOrderPartId: r.id, partId: r.part_id, position: ++pos, status: 'WAITING' }),
        );
        created.push(saved.id);
      }
      if (unique.length) {
        await em.query(`UPDATE production_order_part SET cut_status = 'APPROVED', updated_at = now() WHERE id = ANY($1)`, [unique.map((r) => r.id)]);
      }
      await renumberCutQueue(em);
      if (unique.length) {
        await writeAudit(em, 'cut_queue_item', 'ACTION', created.join(','), { productionOrderPartIds: unique.map((r) => r.id) },
          `Approvati per il taglio ${unique.length} particolari`);
      }
      return { approved: unique.length, skipped: new Set(ids).size - unique.length };
    });
  }

  /** Esclude dal taglio (IGNORE) o rimette in approvazione (UNIGNORE) i particolari indicati. */
  async setIgnored(ids: number[], ignored: boolean) {
    return this.dataSource.transaction(async (em) => {
      // Con RETURNING il driver restituisce [righe, numero righe]
      const raw = await em.query(
        `UPDATE production_order_part SET cut_status = $2, updated_at = now() WHERE id = ANY($1) AND cut_status = $3 RETURNING id`,
        [ids, ignored ? 'IGNORED' : 'NONE', ignored ? 'NONE' : 'IGNORED'],
      );
      const res: { id: number }[] = Array.isArray(raw[0]) ? raw[0] : raw;
      const changed = res.map((r) => r.id);
      if (changed.length) {
        await writeAudit(em, 'production_order_part', 'ACTION', changed.join(','), { ids: changed, cutStatus: ignored ? 'IGNORED' : 'NONE' },
          ignored ? `Esclusi dal taglio ${changed.length} particolari` : `Rimessi in approvazione taglio ${changed.length} particolari`);
      }
      return { updated: changed.length, skipped: new Set(ids).size - changed.length };
    });
  }

  /** Particolari da approvare per il taglio (contatore del menu). */
  async countToApprove(): Promise<number> {
    const [{ n }] = await this.dataSource.query(
      `SELECT COUNT(*)::int AS n FROM production_order_part pop JOIN production_order po ON po.id = pop.production_order_id
        WHERE pop.cut_status = 'NONE' AND ${CANDIDATE_SQL}`,
    );
    return n;
  }

  // ---------------------------------------------------------------------------
  // Coda di taglio
  // ---------------------------------------------------------------------------

  /**
   * Coda di taglio: righe non completate (in ordine di posizione) e completate da ieri in poi, esclusi gli ordini
   * eliminati; per ogni riga non completata la disponibilità di barre in magazzino, prenotata in ordine di coda.
   */
  async queue() {
    const since = fromZonedTime(`${addDays(todayIn(this.timeZone), -1)}T00:00:00`, this.timeZone);
    const rows: any[] = await this.dataSource.query(
      `SELECT ci.id, ci.position::float AS position, ci.status, ci.started_at, ci.completed_at, ci.created_at,
              ci.production_order_id, ci.production_order_part_id, ci.part_id,
              COALESCE(pop.quantity_per_unit,
                       (SELECT SUM(dp.quantity) FROM drawing_part dp WHERE dp.drawing_id = po.drawing_id AND dp.part_id = ci.part_id), 1)::int AS quantity_per_unit,
              po.quantity AS order_quantity, po.expected_delivery_date::text AS expected_delivery_date, po.status AS order_status,
              c.name AS customer_name, co.code AS customer_order_code, d.code AS drawing_code,
              p.internal_code, p.name AS part_name, p.dimensions, p.cut_length_mm, p.bar_type_id,
              mat.name AS material_name, bt.code AS bar_type_code
         FROM cut_queue_item ci
         JOIN production_order po ON po.id = ci.production_order_id AND po.deleted_at IS NULL
         JOIN part p ON p.id = ci.part_id
         LEFT JOIN production_order_part pop ON pop.id = ci.production_order_part_id
         LEFT JOIN material mat ON mat.id = p.material_id
         LEFT JOIN bar_type bt ON bt.id = p.bar_type_id
         LEFT JOIN drawing d ON d.id = po.drawing_id
         LEFT JOIN customer_order co ON co.id = po.customer_order_id
         LEFT JOIN customer c ON c.id = co.customer_id
        WHERE ci.deleted_at IS NULL AND (ci.status <> 'COMPLETED' OR ci.completed_at >= $1)
        ORDER BY (ci.status = 'COMPLETED'), ci.position, ci.id`,
      [since],
    );
    const stockRows: { bar_type_id: number; meters: string }[] = await this.dataSource.query(
      'SELECT bar_type_id, SUM(meters) AS meters FROM bar_stock GROUP BY bar_type_id',
    );
    const stock = new Map(stockRows.map((s) => [s.bar_type_id, Number(s.meters)]));
    const active = rows.filter((r) => r.status !== 'COMPLETED');
    const availability = computeCutAvailability(
      active.map((r) => ({
        id: r.id, barTypeId: r.bar_type_id, cutLengthMm: r.cut_length_mm == null ? null : Number(r.cut_length_mm),
        orderQuantity: r.order_quantity, quantityPerUnit: r.quantity_per_unit,
      })),
      stock,
    );
    let rank = 0;
    const items = rows.map((r) => {
      const { shape, size } = splitDimensions(r.dimensions);
      return {
        id: r.id,
        rank: r.status === 'COMPLETED' ? null : ++rank,
        position: r.position,
        status: r.status,
        startedAt: r.started_at,
        completedAt: r.completed_at,
        createdAt: r.created_at,
        productionOrderId: r.production_order_id,
        productionOrderPartId: r.production_order_part_id,
        orderStatus: r.order_status,
        orderQuantity: r.order_quantity,
        quantityPerUnit: r.quantity_per_unit,
        totalQuantity: r.order_quantity * r.quantity_per_unit,
        expectedDeliveryDate: r.expected_delivery_date,
        customerName: r.customer_name,
        customerOrderCode: r.customer_order_code,
        drawingCode: r.drawing_code,
        part: { id: r.part_id, internalCode: r.internal_code, name: r.part_name, dimensions: r.dimensions, cutLengthMm: r.cut_length_mm == null ? null : Number(r.cut_length_mm) },
        shape,
        size,
        materialName: r.material_name,
        barType: r.bar_type_id ? { id: r.bar_type_id, code: r.bar_type_code } : null,
        availability: availability.get(r.id) ?? null,
      };
    });
    return { generatedAt: new Date(), items };
  }

  /** Riordino della coda di taglio con le stesse regole della pianificazione (posizione tra le righe non completate). */
  async move(id: number, position: number) {
    await this.dataSource.transaction(async (em) => {
      await lockQueue(em, 'cut');
      const item = await em.findOne(CutQueueItem, { where: { id } });
      if (!item) throw new NotFoundException(`Riga della coda di taglio non trovata (id ${id})`);
      if (item.status === 'COMPLETED') throw new BadRequestException('Il taglio è già completato: la riga non si può spostare.');
      await renumberCutQueue(em);
      const fresh = await em.findOneOrFail(CutQueueItem, { where: { id } });
      const [{ n }] = await em.query(
        `SELECT COUNT(*)::int AS n FROM cut_queue_item ci JOIN production_order po ON po.id = ci.production_order_id
          WHERE ci.deleted_at IS NULL AND po.deleted_at IS NULL AND ci.status <> 'COMPLETED'`,
      );
      await em.update(CutQueueItem, id, { position: provisionalPosition({ requested: position, currentRank: fresh.position, maxPosition: n }) });
      await renumberCutQueue(em);
      await writeAudit(em, 'cut_queue_item', 'ACTION', id, { from: fresh.position, to: position }, 'Spostamento nella coda di taglio');
    });
    return this.queue();
  }

  /** Toglie una riga non completata: eliminazione logica e particolare di nuovo da approvare. */
  async remove(id: number): Promise<void> {
    await this.dataSource.transaction(async (em) => {
      await lockQueue(em, 'cut');
      const item = await em.findOne(CutQueueItem, { where: { id } });
      if (!item) throw new NotFoundException(`Riga della coda di taglio non trovata (id ${id})`);
      if (item.status === 'COMPLETED') throw new BadRequestException('Il taglio è completato e resta nello storico: non si può togliere dalla coda.');
      await em.softDelete(CutQueueItem, id);
      if (item.productionOrderPartId) {
        await em.query(
          `UPDATE production_order_part pop SET cut_status = 'NONE', updated_at = now()
            WHERE pop.id = $1 AND pop.cut_status = 'APPROVED'
              AND NOT EXISTS (SELECT 1 FROM cut_queue_item c WHERE c.production_order_part_id = pop.id AND c.deleted_at IS NULL AND c.status <> 'COMPLETED')`,
          [item.productionOrderPartId],
        );
      }
      await renumberCutQueue(em);
      await writeAudit(em, 'cut_queue_item', 'DELETE', id, null, 'Tolto dalla coda di taglio: il particolare torna da approvare');
    });
  }
}
