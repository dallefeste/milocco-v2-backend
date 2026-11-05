import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager, In } from 'typeorm';
import type { CustomerOrderStatus, OrderLineStatus, UserRole } from '../../shared';
import { writeAudit } from '../../common/crud/crud.service';
import { ListQueryDto, Paginated } from '../../common/crud/list-query.dto';
import { CustomerOrder, CustomerOrderLine, Drawing } from '../../entities';
import { customerOrderStatsSql } from './customer-order-sql';
import { CreateCustomerOrderDto, CustomerOrderLineDto, UpdateCustomerOrderDto } from './sales.dto';

export interface CustomerOrderListItem {
  id: number;
  code: string;
  customerId: number;
  customer: { id: number; name: string };
  orderDate: string;
  notes: string | null;
  linesCount: number;
  pendingCount: number;
  confirmedCount: number;
  incompleteCount: number;
  productionOrdersCount: number;
  completionDate: string | null;
  status: CustomerOrderStatus;
  createdAt: string;
  updatedAt: string;
}

const SORTS: Record<string, string> = {
  code: 'co.code',
  orderDate: 'co.order_date',
  'customer.name': 'c.name',
  status: 'x.status',
  completionDate: 'x.completion_date',
  linesCount: 'x.lines_count',
  createdAt: 'co.created_at',
};

/** Ordini cliente: lista con stato calcolato, dettaglio, creazione/modifica righe, eliminazione con controlli. */
@Injectable()
export class CustomerOrdersService {
  constructor(private readonly dataSource: DataSource) {}

  // ------------------------------------------------------------------ Lista

  async list(query: ListQueryDto): Promise<Paginated<CustomerOrderListItem>> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 25;
    const f = query.filter ?? {};
    const where: string[] = [];
    const params: unknown[] = [];
    const p = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };
    if (query.search?.trim()) {
      const t = p(`%${query.search.trim()}%`);
      where.push(`(co.code ILIKE ${t} OR c.name ILIKE ${t} OR co.notes ILIKE ${t} OR EXISTS (
        SELECT 1 FROM customer_order_line sl JOIN drawing sd ON sd.id = sl.drawing_id
         WHERE sl.customer_order_id = co.id AND sl.deleted_at IS NULL AND (sd.code ILIKE ${t} OR sd.name ILIKE ${t})))`);
    }
    if (f.status) {
      const list = f.status.split(',').map((s) => s.trim()).filter(Boolean);
      where.push(`x.status = ANY(${p(list)})`);
    }
    if (f.customerId) where.push(`co.customer_id = ${p(Number(f.customerId))}`);
    if (f.from) where.push(`co.order_date >= ${p(f.from)}::date`);
    if (f.to) where.push(`co.order_date < (${p(f.to)}::date + 1)`);
    if (f.drawingId) where.push(`EXISTS (SELECT 1 FROM customer_order_line dl WHERE dl.customer_order_id = co.id AND dl.deleted_at IS NULL AND dl.drawing_id = ${p(Number(f.drawingId))})`);

    const sortCol = (query.sort && SORTS[query.sort]) || 'co.order_date';
    const order = query.sort && SORTS[query.sort] ? (query.order === 'desc' ? 'DESC' : 'ASC') : 'DESC';
    const sql = `
      SELECT co.id, co.code, co.customer_id, c.name AS customer_name, co.order_date, co.notes,
             co.created_at, co.updated_at, x.lines_count, x.pending_count, x.confirmed_count, x.incomplete_count,
             x.po_count, x.completion_date, x.status, count(*) OVER () AS total
        FROM (${customerOrderStatsSql}) x
        JOIN customer_order co ON co.id = x.id
        JOIN customer c ON c.id = co.customer_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY ${sortCol} ${order} NULLS LAST, co.id DESC
       LIMIT ${p(pageSize)} OFFSET ${p((page - 1) * pageSize)}`;
    const rows: Record<string, any>[] = await this.dataSource.query(sql, params);
    let total = rows.length ? Number(rows[0].total) : 0;
    if (!rows.length && page > 1) {
      const c: { n: number }[] = await this.dataSource.query(
        `SELECT count(*)::int AS n FROM (${customerOrderStatsSql}) x JOIN customer_order co ON co.id = x.id JOIN customer c ON c.id = co.customer_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`,
        params.slice(0, -2),
      );
      total = Number(c[0]?.n ?? 0);
    }
    return { items: rows.map((r) => this.mapListRow(r)), total, page, pageSize };
  }

  private mapListRow(r: Record<string, any>): CustomerOrderListItem {
    return {
      id: Number(r.id),
      code: r.code,
      customerId: Number(r.customer_id),
      customer: { id: Number(r.customer_id), name: r.customer_name },
      orderDate: r.order_date,
      notes: r.notes,
      linesCount: Number(r.lines_count),
      pendingCount: Number(r.pending_count),
      confirmedCount: Number(r.confirmed_count),
      incompleteCount: Number(r.incomplete_count),
      productionOrdersCount: Number(r.po_count),
      completionDate: r.completion_date,
      status: r.status,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  private async stats(em: EntityManager, id: number) {
    const rows = await em.query(
      `SELECT x.*, co.code, co.customer_id, c.name AS customer_name, co.order_date, co.notes, co.created_at, co.updated_at
         FROM (${customerOrderStatsSql} AND co.id = $1) x
         JOIN customer_order co ON co.id = x.id JOIN customer c ON c.id = co.customer_id`,
      [id],
    );
    if (!rows.length) throw new NotFoundException(`Ordine cliente non trovato (id ${id})`);
    return this.mapListRow(rows[0]);
  }

  // ------------------------------------------------------------------ Dettaglio

  /** Ordine con righe, stato dei disegni (particolari senza ciclo), ordini di produzione e preventivi collegati. */
  async detail(id: number, role?: UserRole) {
    const em = this.dataSource.manager;
    const head = await this.stats(em, id);
    const lines: Record<string, any>[] = await em.query(
      `SELECT l.id, l.drawing_id, l.quantity, l.status, l.notes, l.created_at,
              d.code AS drawing_code, d.revision AS drawing_revision, d.name AS drawing_name, d.deleted_at AS drawing_deleted_at
         FROM customer_order_line l JOIN drawing d ON d.id = l.drawing_id
        WHERE l.customer_order_id = $1 AND l.deleted_at IS NULL
        ORDER BY l.id`,
      [id],
    );
    const drawingIds = [...new Set(lines.map((l) => Number(l.drawing_id)))];
    const parts: Record<string, any>[] = drawingIds.length
      ? await em.query(
        `SELECT dp.drawing_id, p.id, p.internal_code, p.name, dp.quantity,
                EXISTS (SELECT 1 FROM part_cycle_step s WHERE s.part_id = p.id) AS has_cycle
           FROM drawing_part dp JOIN part p ON p.id = dp.part_id AND p.deleted_at IS NULL
          WHERE dp.drawing_id = ANY($1) ORDER BY dp.position, dp.id`,
        [drawingIds],
      )
      : [];
    const pos: Record<string, any>[] = await em.query(
      `SELECT p.id, p.customer_order_line_id, p.drawing_id, d.code AS drawing_code, d.revision AS drawing_revision, p.quantity,
              p.stock_quantity, p.expected_delivery_date, p.status, p.completed_at
         FROM production_order p JOIN drawing d ON d.id = p.drawing_id
        WHERE p.customer_order_id = $1 AND p.deleted_at IS NULL ORDER BY p.id`,
      [id],
    );
    const quotes: Record<string, any>[] = role === 'ADMIN'
      ? await em.query('SELECT id, number, issue_date FROM quote WHERE customer_order_id = $1 AND deleted_at IS NULL ORDER BY issue_date DESC, id DESC', [id])
      : [];
    const mapPo = (p: Record<string, any>) => ({
      id: Number(p.id), customerOrderLineId: p.customer_order_line_id === null ? null : Number(p.customer_order_line_id), drawingId: Number(p.drawing_id),
      drawingCode: p.drawing_code, drawingRevision: p.drawing_revision, quantity: Number(p.quantity), stockQuantity: Number(p.stock_quantity),
      expectedDeliveryDate: p.expected_delivery_date, status: p.status, completedAt: p.completed_at,
    });
    return {
      ...head,
      lines: lines.map((l) => {
        const lp = parts.filter((x) => Number(x.drawing_id) === Number(l.drawing_id));
        const missing = lp.filter((x) => !x.has_cycle);
        return {
          id: Number(l.id),
          drawingId: Number(l.drawing_id),
          drawing: { id: Number(l.drawing_id), code: l.drawing_code, revision: l.drawing_revision, name: l.drawing_name, deleted: !!l.drawing_deleted_at },
          quantity: Number(l.quantity),
          status: l.status as OrderLineStatus,
          notes: l.notes,
          drawingComplete: lp.length > 0 && missing.length === 0,
          partsCount: lp.length,
          partsWithoutCycle: missing.map((x) => ({ id: Number(x.id), internalCode: x.internal_code, name: x.name })),
          productionOrders: pos.filter((p) => Number(p.customer_order_line_id) === Number(l.id)).map(mapPo),
        };
      }),
      productionOrders: pos.map(mapPo),
      quotes: quotes.map((q) => ({ id: Number(q.id), number: q.number, issueDate: q.issue_date })),
    };
  }

  // ------------------------------------------------------------------ Creazione e modifica

  private async assertCustomer(em: EntityManager, id: number) {
    const rows = await em.query('SELECT id FROM customer WHERE id = $1 AND deleted_at IS NULL', [id]);
    if (!rows.length) throw new BadRequestException('Cliente non trovato');
  }

  private async assertDrawings(em: EntityManager, lines: CustomerOrderLineDto[]) {
    const ids = [...new Set(lines.map((l) => l.drawingId))];
    if (!ids.length) return;
    const found = await em.getRepository(Drawing).find({ where: { id: In(ids) } });
    const missing = ids.filter((id) => !found.some((d) => d.id === id));
    if (missing.length) throw new BadRequestException(`Disegno non trovato (id ${missing.join(', ')}).`);
  }

  async create(dto: CreateCustomerOrderDto, role?: UserRole) {
    const id = await this.dataSource.transaction(async (em) => {
      await this.assertCustomer(em, dto.customerId);
      await this.assertDrawings(em, dto.lines ?? []);
      const order = await em.getRepository(CustomerOrder).save(
        em.getRepository(CustomerOrder).create({
          code: dto.code.trim(), customerId: dto.customerId, orderDate: dto.orderDate ? new Date(dto.orderDate) : new Date(), notes: dto.notes ?? null,
        }),
      );
      for (const l of dto.lines ?? []) {
        await em.getRepository(CustomerOrderLine).save({ customerOrderId: order.id, drawingId: l.drawingId, quantity: l.quantity, notes: l.notes ?? null, status: 'PENDING' });
      }
      await writeAudit(em, 'customer_order', 'CREATE', order.id, dto, `Ordine cliente ${order.code}`);
      return order.id;
    });
    return this.detail(id, role);
  }

  async update(id: number, dto: UpdateCustomerOrderDto, role?: UserRole) {
    await this.dataSource.transaction(async (em) => {
      const repo = em.getRepository(CustomerOrder);
      const order = await repo.findOne({ where: { id } });
      if (!order) throw new NotFoundException(`Ordine cliente non trovato (id ${id})`);
      if (dto.customerId !== undefined && dto.customerId !== order.customerId) {
        await this.assertCustomer(em, dto.customerId);
        const po = await em.query('SELECT 1 FROM production_order WHERE customer_order_id = $1 AND deleted_at IS NULL LIMIT 1', [id]);
        if (po.length) throw new ConflictException("Non si può cambiare il cliente: l'ordine ha già ordini di produzione.");
      }
      Object.assign(order, {
        ...(dto.code !== undefined && { code: dto.code.trim() }),
        ...(dto.customerId !== undefined && { customerId: dto.customerId }),
        ...(dto.orderDate !== undefined && { orderDate: new Date(dto.orderDate) }),
        ...(dto.notes !== undefined && { notes: dto.notes }),
      });
      await repo.save(order);
      if (dto.lines) await this.syncLines(em, id, dto.lines);
      await writeAudit(em, 'customer_order', 'UPDATE', id, dto, `Ordine cliente ${order.code}`);
    });
    return this.detail(id, role);
  }

  /** Allinea le righe all'elenco ricevuto. Le righe confermate: solo note modificabili, non eliminabili. */
  private async syncLines(em: EntityManager, orderId: number, lines: CustomerOrderLineDto[]) {
    await this.assertDrawings(em, lines);
    const repo = em.getRepository(CustomerOrderLine);
    const existing = await repo.find({ where: { customerOrderId: orderId }, relations: { drawing: true } });
    const label = (l: CustomerOrderLine) => (l.drawing ? `${l.drawing.code}${l.drawing.revision ? ` rev. ${l.drawing.revision}` : ''}` : `#${l.id}`);
    const keep = new Set<number>();
    for (const dto of lines) {
      if (dto.id) {
        const cur = existing.find((l) => l.id === dto.id);
        if (!cur) throw new BadRequestException(`Riga ${dto.id} non appartiene a questo ordine.`);
        keep.add(cur.id);
        if (cur.status === 'CONFIRMED') {
          if (cur.drawingId !== dto.drawingId || cur.quantity !== dto.quantity) {
            throw new ConflictException(`La riga del disegno ${label(cur)} è già confermata: disegno e quantità si cambiano sull'ordine di produzione.`);
          }
          if ((dto.notes ?? null) !== cur.notes) await repo.update(cur.id, { notes: dto.notes ?? null });
          continue;
        }
        await repo.update(cur.id, { drawingId: dto.drawingId, quantity: dto.quantity, notes: dto.notes ?? null });
      } else {
        await repo.save({ customerOrderId: orderId, drawingId: dto.drawingId, quantity: dto.quantity, notes: dto.notes ?? null, status: 'PENDING' });
      }
    }
    for (const cur of existing.filter((l) => !keep.has(l.id))) {
      if (cur.status === 'CONFIRMED') {
        throw new ConflictException(`La riga del disegno ${label(cur)} è già confermata e non si può togliere: elimina prima l'ordine di produzione.`);
      }
      await repo.softDelete(cur.id);
    }
  }

  // ------------------------------------------------------------------ Eliminazione

  /**
   * Elimina (logicamente) l'ordine cliente con righe, ordini di produzione, lavorazioni pianificate e righe
   * di taglio non iniziate. Vietato se un ordine di produzione ha fasi, collaudi o tagli registrati.
   */
  async remove(id: number) {
    await this.dataSource.transaction(async (em) => {
      const order = await em.getRepository(CustomerOrder).findOne({ where: { id } });
      if (!order) throw new NotFoundException(`Ordine cliente non trovato (id ${id})`);
      const busy: { id: number; phases: number; inspections: number; cuts: number }[] = await em.query(
        `SELECT p.id,
                (SELECT count(*)::int FROM work_phase w WHERE w.production_order_id = p.id AND w.deleted_at IS NULL) AS phases,
                (SELECT count(*)::int FROM inspection i WHERE i.production_order_id = p.id AND i.deleted_at IS NULL) AS inspections,
                (SELECT count(*)::int FROM cut_queue_item c WHERE c.production_order_id = p.id AND c.deleted_at IS NULL
                    AND (c.status <> 'WAITING' OR c.started_at IS NOT NULL)) AS cuts
           FROM production_order p
          WHERE p.customer_order_id = $1 AND p.deleted_at IS NULL`,
        [id],
      );
      const blocked = busy.filter((b) => b.phases + b.inspections + b.cuts > 0);
      if (blocked.length) {
        const what = blocked.map((b) => {
          const n = (v: number, one: string, many: string) => (v ? `${v} ${v === 1 ? one : many}` : '');
          const parts = [n(b.phases, 'fase', 'fasi'), n(b.inspections, 'collaudo', 'collaudi'), n(b.cuts, 'taglio', 'tagli')].filter(Boolean).join(', ');
          return `n. ${b.id} (${parts})`;
        });
        throw new ConflictException(
          `L'ordine cliente ${order.code} non si può eliminare: ordini di produzione con attività registrate in reparto: ${what.join('; ')}.`,
        );
      }
      const poIds = busy.map((b) => Number(b.id));
      if (poIds.length) {
        await em.query("UPDATE schedule_item SET deleted_at = now() WHERE production_order_id = ANY($1) AND deleted_at IS NULL", [poIds]);
        await em.query("UPDATE cut_queue_item SET deleted_at = now() WHERE production_order_id = ANY($1) AND deleted_at IS NULL AND status = 'WAITING'", [poIds]);
        await em.query('UPDATE production_order SET deleted_at = now() WHERE id = ANY($1)', [poIds]);
      }
      await em.query('UPDATE customer_order_line SET deleted_at = now() WHERE customer_order_id = $1 AND deleted_at IS NULL', [id]);
      await em.query('UPDATE customer_order SET deleted_at = now() WHERE id = $1', [id]);
      await writeAudit(em, 'customer_order', 'DELETE', id, { productionOrders: poIds }, `Ordine cliente ${order.code} eliminato con ${poIds.length} ordini di produzione`);
    });
  }
}
