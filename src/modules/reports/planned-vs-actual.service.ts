import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { PhaseDataService } from './phase-data.service';
import { dateRange, drawingLabel } from './report-utils';

/**
 * Tempi previsti vs consuntivi (03-report §5.1).
 * Lavorazioni pianificate (non eliminate) su macchine pianificabili, concluse (stato Conclusa, oppure con
 * una fase collegata conclusa, oppure con ordine completato), la cui data di inizio (primo inizio
 * attrezzaggio delle fasi collegate) cade nel periodo. Consuntivo con i tempi netti della regola unica;
 * le pause pianificate non entrano nel previsto.
 */
@Injectable()
export class PlannedVsActualService {
  constructor(
    private readonly ds: DataSource,
    private readonly phases: PhaseDataService,
  ) {}

  async build(q: { from?: string; to?: string; machineId?: number }) {
    const range = dateRange(q.from, q.to);
    const params: unknown[] = [range.start, range.end];
    let machineFilter = '';
    if (q.machineId) { params.push(q.machineId); machineFilter = `AND m.id = $${params.length}`; }
    const items: any[] = await this.ds.query(
      `SELECT si.id, si.machine_id, m.name AS machine_name, mt.name AS machine_type, m.sort_order,
              si.setup_seconds, si.unit_seconds, si.quantity, si.status,
              po.id AS production_order_id, po.status AS order_status, co.id AS customer_order_id, co.code AS customer_order_code,
              c.name AS customer_name, p.id AS part_id, p.internal_code AS part_code, d.code AS drawing_code, d.revision AS drawing_revision,
              x.first_start, x.last_end
         FROM schedule_item si
         JOIN machine m ON m.id = si.machine_id
         JOIN machine_type mt ON mt.id = m.machine_type_id
         JOIN production_order po ON po.id = si.production_order_id
         JOIN customer_order co ON co.id = po.customer_order_id
         JOIN customer c ON c.id = co.customer_id
         JOIN drawing d ON d.id = po.drawing_id
         JOIN part p ON p.id = si.part_id
         JOIN LATERAL (
           SELECT min(wp.setup_started_at) AS first_start, max(wp.work_ended_at) AS last_end, bool_or(wp.status = 'COMPLETED') AS any_done
             FROM work_phase wp WHERE wp.schedule_item_id = si.id AND wp.deleted_at IS NULL
         ) x ON true
        WHERE si.deleted_at IS NULL AND m.deleted_at IS NULL AND m.schedulable
          AND x.first_start >= $1 AND x.first_start < $2
          AND (si.status = 'DONE' OR x.any_done OR po.status = 'COMPLETED') ${machineFilter}
        ORDER BY m.sort_order, m.name, x.first_start`,
      params,
    );
    const phases = items.length ? await this.phases.load('wp.schedule_item_id = ANY($1)', [items.map((i) => i.id)]) : [];

    const machines = new Map<number, { machineId: number; machineName: string; machineType: string; items: any[]; totals: { plannedSetup: number; plannedWork: number; plannedTotal: number; actualSetup: number; actualWork: number; actualTotal: number } }>();
    for (const i of items) {
      const own = phases.filter((p) => p.scheduleItemId === i.id);
      const plannedSetup = i.setup_seconds;
      const plannedWork = i.unit_seconds * i.quantity;
      const actualSetup = own.reduce((s, p) => s + p.times.setupNet, 0);
      const actualWork = own.reduce((s, p) => s + p.times.workNet, 0);
      const plannedTotal = plannedSetup + plannedWork;
      const actualTotal = actualSetup + actualWork;
      const goodQty = own.reduce((s, p) => s + (p.goodQty ?? 0), 0);
      const row = {
        id: i.id as number,
        productionOrderId: i.production_order_id as number,
        customerOrderId: i.customer_order_id as number,
        customerOrderCode: i.customer_order_code as string,
        customerName: i.customer_name as string,
        partId: i.part_id as number,
        partCode: i.part_code as string,
        drawing: drawingLabel(i.drawing_code, i.drawing_revision),
        quantity: i.quantity as number,
        goodQty,
        startedAt: i.first_start as Date,
        endedAt: i.last_end as Date | null,
        phases: own.length,
        plannedSetup, plannedWork, plannedTotal,
        actualSetup, actualWork, actualTotal,
        plannedUnit: i.unit_seconds as number,
        actualUnit: goodQty > 0 ? Math.round(actualWork / goodQty) : null,
        /** Consuntivo / previsto (1 = in linea, >1 = sforamento). */
        ratio: plannedTotal > 0 ? Math.round((actualTotal / plannedTotal) * 1000) / 1000 : null,
      };
      const m = machines.get(i.machine_id) ?? { machineId: i.machine_id, machineName: i.machine_name, machineType: i.machine_type, items: [] as any[], totals: { plannedSetup: 0, plannedWork: 0, plannedTotal: 0, actualSetup: 0, actualWork: 0, actualTotal: 0 } };
      m.items.push(row);
      for (const k of Object.keys(m.totals) as (keyof typeof m.totals)[]) m.totals[k] += row[k];
      machines.set(i.machine_id, m);
    }
    return { from: range.from, to: range.to, machines: [...machines.values()] };
  }
}
