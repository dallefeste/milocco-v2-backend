import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { WorkPhaseStatus } from '../../shared';
import { computePhaseTimes, PhaseTimes } from './time-calc';

/** Fermo di una fase, con la causale. */
export interface StopRow {
  id: number;
  workPhaseId: number;
  reasonId: number | null;
  reasonName: string | null;
  isPause: boolean;
  startedAt: Date;
  endedAt: Date | null;
  machineStopped: boolean;
}

/** Fase con tutti i dati collegati che servono ai report. */
export interface PhaseRow {
  id: number;
  productionOrderId: number;
  partId: number | null;
  partCode: string | null;
  partName: string | null;
  operatorId: number;
  operatorFirstName: string;
  operatorLastName: string;
  machineId: number;
  machineName: string;
  machineTypeId: number;
  machineTypeName: string;
  machineHourlyRate: number;
  /** Tariffa della macchina per il cliente dell'ordine, se esiste. */
  customerRate: number | null;
  scheduleItemId: number | null;
  phaseNumber: number;
  resumedFromId: number | null;
  status: WorkPhaseStatus;
  setupStartedAt: Date;
  setupEndedAt: Date | null;
  workStartedAt: Date | null;
  workEndedAt: Date | null;
  goodQty: number | null;
  scrapQty: number | null;
  orderQuantity: number;
  orderStatus: string;
  quantityPerUnit: number | null;
  customerOrderId: number;
  customerOrderCode: string;
  customerId: number;
  customerName: string;
  drawingId: number;
  drawingCode: string;
  drawingRevision: string;
  stops: StopRow[];
  times: PhaseTimes;
}

/**
 * Lettura delle fasi (non eliminate) con fermi e tempi netti già calcolati.
 * Tutte le query dei report passano da qui, così la regola dei tempi è una sola.
 */
@Injectable()
export class PhaseDataService {
  constructor(private readonly ds: DataSource) {}

  /**
   * @param where condizione SQL sulle tabelle con alias wp (work_phase), po (production_order),
   *              m (machine), co (customer_order); parametri posizionali $1…
   * @param openUntil istante a cui troncare le fasi aperte (vedi time-calc); assente = aperte a zero.
   */
  async load(where: string, params: unknown[], opts: { openUntil?: Date | null; orderBy?: string } = {}): Promise<PhaseRow[]> {
    const rows: any[] = await this.ds.query(
      `SELECT wp.id, wp.production_order_id, wp.part_id, p.internal_code AS part_code, p.name AS part_name,
              wp.operator_id, o.first_name AS operator_first_name, o.last_name AS operator_last_name,
              wp.machine_id, m.name AS machine_name, m.machine_type_id, mt.name AS machine_type_name,
              m.hourly_rate AS machine_hourly_rate, cmr.hourly_rate AS customer_rate,
              wp.schedule_item_id, wp.phase_number, wp.resumed_from_id, wp.status,
              wp.setup_started_at, wp.setup_ended_at, wp.work_started_at, wp.work_ended_at,
              wp.good_qty, wp.scrap_qty, po.quantity AS order_quantity, po.status AS order_status,
              (SELECT pop.quantity_per_unit FROM production_order_part pop
                WHERE pop.production_order_id = po.id AND pop.part_id = wp.part_id ORDER BY pop.id LIMIT 1) AS quantity_per_unit,
              po.customer_order_id, co.code AS customer_order_code, co.customer_id, c.name AS customer_name,
              po.drawing_id, d.code AS drawing_code, d.revision AS drawing_revision
         FROM work_phase wp
         JOIN production_order po ON po.id = wp.production_order_id
         JOIN customer_order co ON co.id = po.customer_order_id
         JOIN customer c ON c.id = co.customer_id
         JOIN drawing d ON d.id = po.drawing_id
         JOIN operator o ON o.id = wp.operator_id
         JOIN machine m ON m.id = wp.machine_id
         JOIN machine_type mt ON mt.id = m.machine_type_id
         LEFT JOIN part p ON p.id = wp.part_id
         LEFT JOIN customer_machine_rate cmr ON cmr.machine_id = m.id AND cmr.customer_id = co.customer_id
        WHERE wp.deleted_at IS NULL AND (${where})
        ORDER BY ${opts.orderBy ?? 'wp.setup_started_at, wp.id'}`,
      params,
    );
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const stops = await this.loadStops(ids);
    const byPhase = new Map<number, StopRow[]>();
    for (const s of stops) {
      const list = byPhase.get(s.workPhaseId) ?? [];
      list.push(s);
      byPhase.set(s.workPhaseId, list);
    }
    return rows.map((r) => {
      const phaseStops = byPhase.get(r.id) ?? [];
      const plannedQty = r.order_quantity * (r.quantity_per_unit ?? 1);
      const base = {
        id: r.id,
        productionOrderId: r.production_order_id,
        partId: r.part_id,
        partCode: r.part_code,
        partName: r.part_name,
        operatorId: r.operator_id,
        operatorFirstName: r.operator_first_name,
        operatorLastName: r.operator_last_name,
        machineId: r.machine_id,
        machineName: r.machine_name,
        machineTypeId: r.machine_type_id,
        machineTypeName: r.machine_type_name,
        machineHourlyRate: Number(r.machine_hourly_rate ?? 0),
        customerRate: r.customer_rate === null ? null : Number(r.customer_rate),
        scheduleItemId: r.schedule_item_id,
        phaseNumber: r.phase_number,
        resumedFromId: r.resumed_from_id,
        status: r.status,
        setupStartedAt: r.setup_started_at,
        setupEndedAt: r.setup_ended_at,
        workStartedAt: r.work_started_at,
        workEndedAt: r.work_ended_at,
        goodQty: r.good_qty,
        scrapQty: r.scrap_qty,
        orderQuantity: r.order_quantity,
        orderStatus: r.order_status,
        quantityPerUnit: r.quantity_per_unit,
        customerOrderId: r.customer_order_id,
        customerOrderCode: r.customer_order_code,
        customerId: r.customer_id,
        customerName: r.customer_name,
        drawingId: r.drawing_id,
        drawingCode: r.drawing_code,
        drawingRevision: r.drawing_revision ?? '',
        stops: phaseStops,
      };
      const times = computePhaseTimes(
        { ...base, stops: phaseStops.map((s) => ({ startedAt: s.startedAt, endedAt: s.endedAt, machineStopped: s.machineStopped, isPause: s.isPause })) },
        { openUntil: opts.openUntil ?? null, plannedQty },
      );
      return { ...base, times };
    });
  }

  async loadStops(phaseIds: number[]): Promise<StopRow[]> {
    if (phaseIds.length === 0) return [];
    const rows: any[] = await this.ds.query(
      `SELECT ws.id, ws.work_phase_id, ws.stop_reason_id, sr.name AS reason_name, sr.kind,
              ws.started_at, ws.ended_at, ws.machine_stopped
         FROM work_stop ws
         LEFT JOIN stop_reason sr ON sr.id = ws.stop_reason_id
        WHERE ws.deleted_at IS NULL AND ws.work_phase_id = ANY($1)
        ORDER BY ws.started_at, ws.id`,
      [phaseIds],
    );
    return rows.map((r) => ({
      id: r.id,
      workPhaseId: r.work_phase_id,
      reasonId: r.stop_reason_id,
      reasonName: r.reason_name,
      isPause: r.kind === 'PAUSE',
      startedAt: r.started_at,
      endedAt: r.ended_at,
      machineStopped: r.machine_stopped,
    }));
  }
}

/** Tariffa oraria applicata a una fase: quella per il cliente se esiste, altrimenti quella della macchina. */
export const phaseRate = (p: Pick<PhaseRow, 'customerRate' | 'machineHourlyRate'>): number => p.customerRate ?? p.machineHourlyRate ?? 0;
