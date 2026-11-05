import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { writeAudit } from '../../common/crud/crud.service';
import { ProductionOrder, ProductionOrderPart, ScheduleItem } from '../../entities';
import { ConfirmCustomerOrderDto } from './sales.dto';

export interface ConfirmMachineOption {
  id: number;
  name: string;
  /** Lavorazioni non concluse in coda. */
  queueItems: number;
  /** Tempo previsto delle lavorazioni in coda (secondi). */
  queueSeconds: number;
}

export interface ConfirmPhase {
  drawingPartId: number;
  cycleStepId: number;
  partId: number;
  partCode: string;
  partName: string;
  machineTypeId: number;
  machineTypeName: string;
  sequence: number;
  setupSeconds: number;
  unitSeconds: number;
  quantityPerUnit: number;
  machines: ConfirmMachineOption[];
  suggestedMachineId: number | null;
  suggestionReason: 'QUOTE' | 'SHORTEST_QUEUE' | null;
}

interface StepRow {
  drawing_id: number;
  drawing_part_id: number;
  part_id: number;
  internal_code: string;
  part_name: string;
  qpu: number;
  step_id: number | null;
  machine_type_id: number | null;
  type_name: string | null;
  plan: boolean | null;
  sequence: number | null;
  setup_seconds: number | null;
  unit_seconds: number | null;
}

/**
 * Conferma dell'ordine cliente (01-commerciale §2.5, 02-produzione §3.3b): crea ordini di produzione,
 * particolari dell'ordine e lavorazioni pianificate in un'unica transazione.
 */
@Injectable()
export class CustomerOrderConfirmService {
  constructor(private readonly dataSource: DataSource) {}

  private async loadSteps(em: EntityManager, drawingIds: number[]): Promise<StepRow[]> {
    if (!drawingIds.length) return [];
    return em.query(
      `SELECT dp.drawing_id, dp.id AS drawing_part_id, p.id AS part_id, p.internal_code, p.name AS part_name, dp.quantity AS qpu,
              s.id AS step_id, s.machine_type_id, mt.name AS type_name, mt.plan_on_order_confirm AS plan, s.sequence,
              s.setup_seconds, s.unit_seconds
         FROM drawing_part dp
         JOIN part p ON p.id = dp.part_id AND p.deleted_at IS NULL
         LEFT JOIN part_cycle_step s ON s.part_id = p.id
         LEFT JOIN machine_type mt ON mt.id = s.machine_type_id
        WHERE dp.drawing_id = ANY($1)
        ORDER BY dp.position, dp.id, s.sequence, s.id`,
      [drawingIds],
    );
  }

  private async queues(em: EntityManager, typeIds: number[]): Promise<Map<number, ConfirmMachineOption[]>> {
    const out = new Map<number, ConfirmMachineOption[]>();
    if (!typeIds.length) return out;
    const rows: { id: number; name: string; machine_type_id: number; items: number; seconds: string }[] = await em.query(
      `SELECT m.id, m.name, m.machine_type_id,
              count(si.id)::int AS items,
              COALESCE(sum(si.setup_seconds + si.unit_seconds * si.quantity + si.internal_pause_seconds + si.end_pause_seconds), 0) AS seconds
         FROM machine m
         LEFT JOIN schedule_item si ON si.machine_id = m.id AND si.deleted_at IS NULL AND si.status <> 'DONE'
              AND EXISTS (SELECT 1 FROM production_order po WHERE po.id = si.production_order_id AND po.deleted_at IS NULL AND po.status <> 'COMPLETED')
        WHERE m.deleted_at IS NULL AND m.schedulable AND m.machine_type_id = ANY($1)
        GROUP BY m.id
        ORDER BY m.sort_order, m.name, m.id`,
      [typeIds],
    );
    for (const r of rows) {
      const list = out.get(Number(r.machine_type_id)) ?? [];
      list.push({ id: Number(r.id), name: r.name, queueItems: Number(r.items), queueSeconds: Number(r.seconds) });
      out.set(Number(r.machine_type_id), list);
    }
    return out;
  }

  /** Righe ancora da confermare con fasi da pianificare, macchine ammesse e cosa manca. */
  async proposal(orderId: number) {
    const em = this.dataSource.manager;
    const head: Record<string, any>[] = await em.query(
      `SELECT co.id, co.code, co.notes, co.order_date, c.id AS customer_id, c.name AS customer_name
         FROM customer_order co JOIN customer c ON c.id = co.customer_id
        WHERE co.id = $1 AND co.deleted_at IS NULL`,
      [orderId],
    );
    if (!head.length) throw new NotFoundException(`Ordine cliente non trovato (id ${orderId})`);
    const lines: Record<string, any>[] = await em.query(
      `SELECT l.id, l.drawing_id, l.quantity, l.notes, l.status, d.code, d.revision, d.name, d.deleted_at AS drawing_deleted
         FROM customer_order_line l JOIN drawing d ON d.id = l.drawing_id
        WHERE l.customer_order_id = $1 AND l.deleted_at IS NULL ORDER BY l.id`,
      [orderId],
    );
    const pending = lines.filter((l) => l.status === 'PENDING');
    const steps = await this.loadSteps(em, [...new Set(pending.map((l) => Number(l.drawing_id)))]);
    const planTypes = [...new Set(steps.filter((s) => s.plan).map((s) => Number(s.machine_type_id)))];
    const machines = await this.queues(em, planTypes);
    // Macchine usate nel preventivo collegato all'ordine (stesso particolare e tipologia)
    const quoteMachines: { part_id: number; machine_type_id: number; machine_id: number }[] = await em.query(
      `SELECT DISTINCT ON (qp.part_id, f.machine_type_id) qp.part_id, f.machine_type_id, f.machine_id
         FROM quote q JOIN quote_part qp ON qp.quote_id = q.id AND qp.deleted_at IS NULL
         JOIN quote_part_phase f ON f.quote_part_id = qp.id AND f.machine_id IS NOT NULL
        WHERE q.customer_order_id = $1 AND q.deleted_at IS NULL
        ORDER BY qp.part_id, f.machine_type_id, q.issue_date DESC, q.id DESC`,
      [orderId],
    );

    return {
      order: {
        id: Number(head[0].id), code: head[0].code, notes: head[0].notes, orderDate: head[0].order_date,
        customer: { id: Number(head[0].customer_id), name: head[0].customer_name },
      },
      confirmedLines: lines.length - pending.length,
      lines: pending.map((l) => {
        const ls = steps.filter((s) => Number(s.drawing_id) === Number(l.drawing_id));
        const byDp = new Map<number, StepRow[]>();
        for (const s of ls) byDp.set(Number(s.drawing_part_id), [...(byDp.get(Number(s.drawing_part_id)) ?? []), s]);
        const problems: string[] = [];
        if (l.drawing_deleted) problems.push('Il disegno è stato eliminato.');
        if (!byDp.size) problems.push('Il disegno non ha particolari.');
        const parts = [...byDp.values()].map((rows) => ({
          drawingPartId: Number(rows[0].drawing_part_id), partId: Number(rows[0].part_id), internalCode: rows[0].internal_code, name: rows[0].part_name,
          quantityPerUnit: Number(rows[0].qpu), hasCycle: rows.some((r) => r.step_id !== null),
        }));
        for (const p of parts.filter((x) => !x.hasCycle)) problems.push(`Il particolare ${p.internalCode} non ha il ciclo di lavorazione.`);
        const phases: ConfirmPhase[] = ls.filter((s) => s.step_id !== null && s.plan).map((s) => {
          const options = machines.get(Number(s.machine_type_id)) ?? [];
          const fromQuote = quoteMachines.find((q) => Number(q.part_id) === Number(s.part_id) && Number(q.machine_type_id) === Number(s.machine_type_id));
          let suggested: ConfirmMachineOption | undefined = fromQuote ? options.find((m) => m.id === Number(fromQuote.machine_id)) : undefined;
          let reason: ConfirmPhase['suggestionReason'] = suggested ? 'QUOTE' : null;
          if (!suggested && options.length) {
            suggested = options.reduce((best, m) => (m.queueSeconds < best.queueSeconds || (m.queueSeconds === best.queueSeconds && m.queueItems < best.queueItems) ? m : best), options[0]);
            reason = 'SHORTEST_QUEUE';
          }
          return {
            drawingPartId: Number(s.drawing_part_id), cycleStepId: Number(s.step_id), partId: Number(s.part_id), partCode: s.internal_code, partName: s.part_name,
            machineTypeId: Number(s.machine_type_id), machineTypeName: s.type_name ?? '', sequence: Number(s.sequence),
            setupSeconds: Number(s.setup_seconds), unitSeconds: Number(s.unit_seconds), quantityPerUnit: Number(s.qpu),
            machines: options, suggestedMachineId: suggested?.id ?? null, suggestionReason: reason,
          };
        });
        for (const ph of phases.filter((x) => !x.machines.length)) {
          problems.push(`Nessuna macchina pianificabile per la tipologia ${ph.machineTypeName} (fase del particolare ${ph.partCode}).`);
        }
        return {
          id: Number(l.id),
          drawing: { id: Number(l.drawing_id), code: l.code, revision: l.revision, name: l.name },
          quantity: Number(l.quantity),
          notes: l.notes,
          ready: problems.length === 0,
          problems,
          parts,
          phases,
        };
      }),
    };
  }

  /** Conferma le righe scelte: tutto o niente. */
  async confirm(orderId: number, dto: ConfirmCustomerOrderDto) {
    if (!dto.lines.length) throw new BadRequestException('Scegli almeno una riga da confermare.');
    const lineIds = dto.lines.map((l) => l.lineId);
    if (new Set(lineIds).size !== lineIds.length) throw new BadRequestException('La stessa riga compare due volte.');

    return this.dataSource.transaction(async (em) => {
      const order: { id: number; code: string }[] = await em.query('SELECT id, code FROM customer_order WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [orderId]);
      if (!order.length) throw new NotFoundException(`Ordine cliente non trovato (id ${orderId})`);
      const lines: { id: number; drawing_id: number; status: string; code: string; revision: string; drawing_deleted: string | null }[] = await em.query(
        `SELECT l.id, l.drawing_id, l.status, d.code, d.revision, d.deleted_at AS drawing_deleted
           FROM customer_order_line l JOIN drawing d ON d.id = l.drawing_id
          WHERE l.customer_order_id = $1 AND l.deleted_at IS NULL AND l.id = ANY($2)
          FOR UPDATE OF l`,
        [orderId, lineIds],
      );
      const steps = await this.loadSteps(em, [...new Set(lines.map((l) => Number(l.drawing_id)))]);
      const created: { productionOrderId: number; drawing: string; quantity: number; scheduleItems: number }[] = [];
      const lockedMachines = new Set<number>();

      for (const dl of dto.lines) {
        const line = lines.find((l) => Number(l.id) === dl.lineId);
        if (!line) throw new BadRequestException(`La riga ${dl.lineId} non appartiene a questo ordine o è stata eliminata.`);
        const label = `${line.code}${line.revision ? ` rev. ${line.revision}` : ''}`;
        if (line.status !== 'PENDING') throw new ConflictException(`Il disegno ${label} è già confermato: ricarica la pagina.`);
        if (line.drawing_deleted) throw new BadRequestException(`Il disegno ${label} è stato eliminato.`);
        if (dl.stockQuantity > dl.quantity) throw new BadRequestException(`Disegno ${label}: la quantità per magazzino non può superare la quantità.`);
        const ls = steps.filter((s) => Number(s.drawing_id) === Number(line.drawing_id));
        const dps = [...new Map(ls.map((s) => [Number(s.drawing_part_id), s])).values()];
        if (!dps.length) throw new BadRequestException(`Il disegno ${label} non ha particolari.`);
        const noCycle = dps.filter((dp) => !ls.some((s) => Number(s.drawing_part_id) === Number(dp.drawing_part_id) && s.step_id !== null));
        if (noCycle.length) throw new BadRequestException(`Disegno ${label}: manca il ciclo di lavorazione per ${noCycle.map((x) => x.internal_code).join(', ')}.`);

        // Ogni fase da pianificare deve avere una scelta (macchina o "non pianificare")
        const toPlan = ls.filter((s) => s.step_id !== null && s.plan);
        for (const s of toPlan) {
          if (!dl.phases.some((p) => p.drawingPartId === Number(s.drawing_part_id) && p.cycleStepId === Number(s.step_id))) {
            throw new BadRequestException(`Disegno ${label}: manca la scelta della macchina per la fase ${s.type_name} del particolare ${s.internal_code}.`);
          }
        }

        const po = await em.getRepository(ProductionOrder).save(
          em.getRepository(ProductionOrder).create({
            customerOrderId: orderId, customerOrderLineId: dl.lineId, drawingId: Number(line.drawing_id), quantity: dl.quantity,
            stockQuantity: dl.stockQuantity, expectedDeliveryDate: dl.expectedDeliveryDate.slice(0, 10), status: 'TO_DO', notes: dl.notes ?? null,
          }),
        );
        await em.query(
          'INSERT INTO production_order_treatment (production_order_id, treatment_id) SELECT $1, dt.treatment_id FROM drawing_treatment dt WHERE dt.drawing_id = $2 ON CONFLICT DO NOTHING',
          [po.id, Number(line.drawing_id)],
        );
        await em.getRepository(ProductionOrderPart).save(
          dps.map((dp) => ({ productionOrderId: po.id, partId: Number(dp.part_id), quantityPerUnit: Number(dp.qpu), cutStatus: 'NONE' as const })),
        );

        let items = 0;
        for (const ph of dl.phases) {
          const step = toPlan.find((s) => Number(s.drawing_part_id) === ph.drawingPartId && Number(s.step_id) === ph.cycleStepId);
          if (!step) throw new BadRequestException(`Disegno ${label}: fase indicata non presente nel ciclo (ricarica la pagina).`);
          if (!ph.machineId) continue; // scelta esplicita: non pianificare ora
          const m: { id: number; name: string; machine_type_id: number; schedulable: boolean }[] = await em.query(
            'SELECT id, name, machine_type_id, schedulable FROM machine WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
            [ph.machineId],
          );
          if (!m.length) throw new BadRequestException(`Disegno ${label}: macchina non trovata (id ${ph.machineId}).`);
          if (Number(m[0].machine_type_id) !== Number(step.machine_type_id) || !m[0].schedulable) {
            throw new BadRequestException(`Disegno ${label}: la macchina ${m[0].name} non è ammessa per la fase ${step.type_name}.`);
          }
          lockedMachines.add(ph.machineId);
          const pos: { p: string }[] = await em.query(
            "SELECT COALESCE(max(position), 0) + 1 AS p FROM schedule_item WHERE machine_id = $1 AND deleted_at IS NULL AND status <> 'DONE'",
            [ph.machineId],
          );
          await em.getRepository(ScheduleItem).save(
            em.getRepository(ScheduleItem).create({
              productionOrderId: po.id, partId: Number(step.part_id), machineId: ph.machineId,
              setupSeconds: Number(step.setup_seconds ?? 0), unitSeconds: Number(step.unit_seconds ?? 0),
              internalPauseSeconds: ph.internalPauseSeconds ?? 0, endPauseSeconds: ph.endPauseSeconds ?? 0,
              quantity: dl.quantity * Number(step.qpu), position: Number(pos[0].p), status: 'OPEN',
            }),
          );
          items++;
        }
        await em.query("UPDATE customer_order_line SET status = 'CONFIRMED', updated_at = now() WHERE id = $1", [dl.lineId]);
        await writeAudit(em, 'production_order', 'CREATE', po.id, { ...dl }, `Creato dalla conferma dell'ordine cliente ${order[0].code}`);
        created.push({ productionOrderId: po.id, drawing: label, quantity: dl.quantity, scheduleItems: items });
      }
      await writeAudit(em, 'customer_order', 'ACTION', orderId, { lines: lineIds }, `Conferma di ${created.length} righe: ordini di produzione ${created.map((c) => c.productionOrderId).join(', ')}`);
      return { productionOrders: created, scheduleItems: created.reduce((s, c) => s + c.scheduleItems, 0) };
    });
  }
}
