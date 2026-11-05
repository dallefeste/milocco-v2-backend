import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, IsNull } from 'typeorm';
import { ExtraActivityLog, Inspection, Machine, WorkPhase } from '../../../entities';
import { effectiveStatusSql } from '../common/production-db';

/** Una fase aperta da più di così è probabilmente rimasta aperta per errore e va chiusa dall'ufficio. */
const STALE_SECONDS = 16 * 3600;

const name = (o?: { firstName?: string; lastName?: string } | null) => (o ? `${o.firstName ?? ''} ${o.lastName ?? ''}`.trim() : null);
const seconds = (from: Date | string, now: Date) => Math.max(0, Math.round((now.getTime() - new Date(from).getTime()) / 1000));

/** Stato del reparto in tempo reale: cosa succede adesso su ogni macchina. */
@Injectable()
export class ShopStatusService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async status(now = new Date()) {
    const em = this.dataSource.manager;
    const machines = await em.find(Machine, { relations: { machineType: true }, order: { sortOrder: 'ASC', name: 'ASC' } });
    const phases = await em.find(WorkPhase, {
      where: { status: 'IN_PROGRESS' },
      relations: { operator: true, part: true, productionOrder: { drawing: true, customerOrder: { customer: true } }, stops: { stopReason: true } },
      order: { setupStartedAt: 'DESC' },
    });
    const inspections = await em.find(Inspection, {
      where: { endedAt: IsNull() },
      relations: { operator: true, productionOrder: { drawing: true, customerOrder: { customer: true } } },
      order: { startedAt: 'DESC' },
    });
    const extras = await em.find(ExtraActivityLog, {
      where: { endedAt: IsNull() },
      relations: { operator: true, extraActivity: true, machine: true },
      order: { startedAt: 'DESC' },
    });
    const next: { machine_id: number; id: number; production_order_id: number; part_code: string; part_name: string; quantity: number }[] = await em.query(
      `SELECT DISTINCT ON (si.machine_id) si.machine_id, si.id, si.production_order_id, p.internal_code AS part_code, p.name AS part_name, si.quantity
         FROM schedule_item si JOIN production_order po ON po.id = si.production_order_id AND po.deleted_at IS NULL
         JOIN part p ON p.id = si.part_id
        WHERE si.deleted_at IS NULL AND ${effectiveStatusSql()} = 'OPEN'
        ORDER BY si.machine_id, si.position, si.id`,
    );
    const [lastRows]: [{ machine_id: number; last_end: Date }[]] = [
      await em.query(
        `SELECT machine_id, MAX(COALESCE(work_ended_at, setup_ended_at)) AS last_end FROM work_phase
          WHERE deleted_at IS NULL AND status <> 'IN_PROGRESS' AND setup_started_at > now() - interval '30 days' GROUP BY machine_id`,
      ),
    ];

    const orderInfo = (po?: WorkPhase['productionOrder']) =>
      po ? { id: po.id, drawingCode: po.drawing?.code ?? null, customerName: po.customerOrder?.customer?.name ?? null, customerOrderCode: po.customerOrder?.code ?? null, quantity: po.quantity } : null;

    const phaseView = (p: WorkPhase) => {
      const openStop = (p.stops ?? []).filter((s) => !s.deletedAt && !s.endedAt).sort((a, b) => +new Date(b.startedAt) - +new Date(a.startedAt))[0];
      let state: 'SETUP' | 'WORKING' | 'STOPPED' | 'PAUSE';
      let since: Date;
      if (openStop) {
        state = openStop.machineStopped ? 'STOPPED' : 'PAUSE';
        since = openStop.startedAt;
      } else if (p.workStartedAt && !p.workEndedAt) {
        state = 'WORKING';
        since = p.workStartedAt;
      } else {
        state = 'SETUP';
        since = p.setupStartedAt;
      }
      return {
        id: p.id,
        state,
        since,
        sinceSeconds: seconds(since, now),
        phaseStartedAt: p.setupStartedAt,
        stale: seconds(p.setupStartedAt, now) > STALE_SECONDS,
        operator: p.operator ? { id: p.operator.id, name: name(p.operator) } : null,
        productionOrder: orderInfo(p.productionOrder),
        part: p.part ? { id: p.part.id, internalCode: p.part.internalCode, name: p.part.name } : null,
        phaseNumber: p.phaseNumber,
        goodQty: p.goodQty,
        stopReason: openStop?.stopReason?.name ?? null,
      };
    };

    const out = machines.map((m) => {
      const open = phases.filter((p) => p.machineId === m.id).map(phaseView);
      const insp = inspections.filter((i) => i.machineId === m.id).map((i) => ({
        id: i.id, since: i.startedAt, sinceSeconds: seconds(i.startedAt, now), stale: seconds(i.startedAt, now) > STALE_SECONDS,
        operator: i.operator ? { id: i.operator.id, name: name(i.operator) } : null, productionOrder: orderInfo(i.productionOrder),
      }));
      const ex = extras.filter((e) => e.machineId === m.id);
      // Le fasi aperte da troppo tempo (dimenticate aperte) non descrivono cosa succede adesso: stato STALE.
      const fresh = open.filter((p) => !p.stale);
      const main = fresh[0] ?? null;
      const freshInsp = insp.filter((i) => !i.stale);
      const state = main ? main.state : freshInsp.length ? 'INSPECTION' : ex.length ? 'EXTRA' : open.length || insp.length ? 'STALE' : 'IDLE';
      const n = next.find((x) => x.machine_id === m.id);
      return {
        machine: { id: m.id, name: m.name, machineTypeName: m.machineType?.name ?? null, schedulable: m.schedulable, isCutting: !!m.machineType?.isCutting, isInspection: !!m.machineType?.isInspection },
        state,
        current: main,
        /** Altre fasi aperte sulla stessa macchina (spesso dimenticate aperte). */
        otherOpenPhases: open.filter((p) => p !== main),
        inspections: insp,
        extraActivities: ex.map((e) => ({ id: e.id, name: e.extraActivity?.name ?? null, operator: name(e.operator), since: e.startedAt, sinceSeconds: seconds(e.startedAt, now) })),
        lastActivityEnd: lastRows.find((r) => r.machine_id === m.id)?.last_end ?? null,
        next: n ? { scheduleItemId: n.id, productionOrderId: n.production_order_id, partCode: n.part_code, partName: n.part_name, quantity: n.quantity } : null,
      };
    });

    return {
      generatedAt: now,
      machines: out,
      extraActivities: extras.map((e) => ({
        id: e.id, name: e.extraActivity?.name ?? null, operator: e.operator ? { id: e.operator.id, name: name(e.operator) } : null,
        machine: e.machine ? { id: e.machine.id, name: e.machine.name } : null, since: e.startedAt, sinceSeconds: seconds(e.startedAt, now),
        stale: seconds(e.startedAt, now) > STALE_SECONDS,
      })),
      openInspections: inspections.filter((i) => !i.machineId).map((i) => ({
        id: i.id, since: i.startedAt, sinceSeconds: seconds(i.startedAt, now), operator: i.operator ? { id: i.operator.id, name: name(i.operator) } : null,
        productionOrder: orderInfo(i.productionOrder),
      })),
      summary: {
        working: out.filter((m) => m.state === 'WORKING').length,
        setup: out.filter((m) => m.state === 'SETUP').length,
        stopped: out.filter((m) => m.state === 'STOPPED' || m.state === 'PAUSE').length,
        idle: out.filter((m) => m.state === 'IDLE').length,
        stale: out.filter((m) => m.state === 'STALE').length,
        openPhases: phases.length,
        stalePhases: phases.filter((p) => seconds(p.setupStartedAt, now) > STALE_SECONDS).length,
      },
    };
  }
}
