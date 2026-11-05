import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { fromZonedTime } from 'date-fns-tz';
import { DataSource, EntityManager, IsNull, Repository, SelectQueryBuilder } from 'typeorm';
import { CrudService, writeAudit } from '../../../common/crud/crud.service';
import { ListQueryDto } from '../../../common/crud/list-query.dto';
import { ExtraActivity, ExtraActivityLog, Inspection, Machine, ScheduleItem, StopReason, WorkPhase, WorkStop } from '../../../entities';
import { lockQueue, renumberMachine } from '../common/production-db';
import { addDays, phaseWorkedSeconds } from '../planning/schedule-plan';
import { CloseWorkPhaseDto, CorrectExtraActivityLogDto, CorrectInspectionDto, CorrectWorkPhaseDto, CorrectWorkStopDto, ShopListQueryDto } from './shop.dto';

const d = (v: string | Date | null | undefined): Date | null => (v == null ? null : new Date(v));
const t = (v: Date | null | undefined) => (v ? v.getTime() : null);

/** Unisce ?productionOrderId= e il periodo ai filtri standard. */
export function shopQuery(q: ShopListQueryDto): ListQueryDto {
  const filter = { ...(q.filter ?? {}) };
  if (q.productionOrderId) filter.productionOrderId = String(q.productionOrderId);
  if (q.from) filter.from = q.from;
  if (q.to) filter.to = q.to;
  return { ...q, filter };
}

/** Filtro periodo su una colonna data-ora, con date locali dell'officina (estremi inclusi). */
function periodFilter(qb: SelectQueryBuilder<any>, column: string, f: Record<string, string>, timeZone: string) {
  if (f.from) qb.andWhere(`${column} >= :pFrom`, { pFrom: fromZonedTime(`${f.from.slice(0, 10)}T00:00:00`, timeZone) });
  if (f.to) qb.andWhere(`${column} < :pTo`, { pTo: fromZonedTime(`${addDays(f.to.slice(0, 10), 1)}T00:00:00`, timeZone) });
}

function checkInterval(a: Date | null, b: Date | null, what: string) {
  if (a && b && b.getTime() < a.getTime()) throw new BadRequestException(`${what}: la fine non può precedere l'inizio.`);
  if (b && b.getTime() > Date.now() + 5 * 60_000) throw new BadRequestException(`${what}: la fine non può essere nel futuro.`);
}

/** Tempi netti di una fase (attrezzaggio meno tutti i fermi, lavorazione meno i fermi a macchina ferma). */
export function phaseTimes(p: WorkPhase, now = new Date()) {
  const stops = (p.stops ?? []).filter((s) => !s.deletedAt);
  const total = phaseWorkedSeconds({ ...p, stops }, now);
  const setup = phaseWorkedSeconds({ ...p, setupEndedAt: p.setupEndedAt ?? p.workStartedAt, workStartedAt: null, workEndedAt: null, stops }, now);
  const stopSeconds = stops.reduce((s, x) => s + Math.max(0, ((t(x.endedAt ? new Date(x.endedAt) : null) ?? now.getTime()) - new Date(x.startedAt).getTime()) / 1000), 0);
  return { setupSeconds: setup, workSeconds: Math.max(0, total - setup), totalSeconds: total, stopSeconds: Math.round(stopSeconds) };
}

// ---------------------------------------------------------------------------
// Fasi
// ---------------------------------------------------------------------------

@Injectable()
export class WorkPhasesService extends CrudService<WorkPhase> {
  private readonly timeZone: string;

  constructor(
    @InjectRepository(WorkPhase) repo: Repository<WorkPhase>,
    @InjectDataSource() private readonly dataSource: DataSource,
    config: ConfigService,
  ) {
    super(repo, {
      label: 'Fase',
      relations: ['operator', 'machine', 'part', 'productionOrder', 'productionOrder.drawing', 'productionOrder.customerOrder', 'productionOrder.customerOrder.customer'],
      searchFields: ['productionOrderId', 'part.internalCode', 'part.name', 'operator.lastName', 'operator.firstName', 'machine.name', 'productionOrder.drawing.code'],
      sortable: ['id', 'setupStartedAt', 'setupEndedAt', 'workStartedAt', 'workEndedAt', 'goodQty', 'scrapQty', 'phaseNumber', 'status', 'productionOrderId', 'machine.name', 'operator.lastName', 'part.internalCode'],
      filterable: ['machineId', 'operatorId', 'productionOrderId', 'partId', 'status', 'scheduleItemId'],
      defaultSort: { field: 'setupStartedAt', order: 'desc' },
    });
    this.timeZone = config.get<string>('timezone') ?? 'Europe/Rome';
  }

  protected override customizeList(qb: SelectQueryBuilder<WorkPhase>, query: ListQueryDto): void {
    periodFilter(qb, 'e.setupStartedAt', query.filter ?? {}, this.timeZone);
    qb.loadRelationCountAndMap('e.stopCount', 'e.stops');
  }

  async detail(id: number) {
    const phase = await this.repo.findOne({
      where: { id },
      withDeleted: true,
      relations: { operator: true, machine: true, part: true, scheduleItem: true, productionOrder: { drawing: true, customerOrder: { customer: true } }, stops: { stopReason: true } },
    });
    if (!phase) throw new NotFoundException(`Fase non trovata (id ${id})`);
    phase.stops = (phase.stops ?? []).filter((s) => !s.deletedAt).sort((a, b) => +new Date(a.startedAt) - +new Date(b.startedAt));
    return { ...phase, times: phaseTimes(phase) };
  }

  /** Correzione d'ufficio (orari, pezzi, stato) con registro modifiche. Chiudendo la fase chiude i fermi aperti. */
  async correct(id: number, dto: CorrectWorkPhaseDto) {
    await this.dataSource.transaction((em) => this.applyCorrection(em, id, dto));
    return this.detail(id);
  }

  /** Chiude una fase rimasta aperta: fine attrezzaggio o lavorazione all'ora indicata, pezzi e stato finale. */
  async close(id: number, dto: CloseWorkPhaseDto) {
    await this.dataSource.transaction(async (em) => {
      const p = await em.findOne(WorkPhase, { where: { id } });
      if (!p) throw new NotFoundException(`Fase non trovata (id ${id})`);
      if (p.status !== 'IN_PROGRESS') throw new BadRequestException('La fase è già chiusa: usare la correzione per modificarla.');
      const end = dto.endedAt ?? new Date().toISOString();
      const patch: CorrectWorkPhaseDto = { status: dto.status, goodQty: dto.goodQty, scrapQty: dto.scrapQty, reason: dto.reason ?? 'Chiusura d\'ufficio di una fase rimasta aperta' };
      if (p.workStartedAt) { if (!p.workEndedAt) patch.workEndedAt = end; } else if (!p.setupEndedAt) patch.setupEndedAt = end;
      await this.applyCorrection(em, id, patch);
    });
    return this.detail(id);
  }

  private async applyCorrection(em: EntityManager, id: number, dto: CorrectWorkPhaseDto) {
    const before = await em.findOne(WorkPhase, { where: { id } });
    if (!before) throw new NotFoundException(`Fase non trovata (id ${id})`);
    const next = {
      status: dto.status ?? before.status,
      setupStartedAt: dto.setupStartedAt !== undefined ? d(dto.setupStartedAt)! : before.setupStartedAt,
      setupEndedAt: dto.setupEndedAt !== undefined ? d(dto.setupEndedAt) : before.setupEndedAt,
      workStartedAt: dto.workStartedAt !== undefined ? d(dto.workStartedAt) : before.workStartedAt,
      workEndedAt: dto.workEndedAt !== undefined ? d(dto.workEndedAt) : before.workEndedAt,
      goodQty: dto.goodQty !== undefined ? dto.goodQty : before.goodQty,
      scrapQty: dto.scrapQty !== undefined ? dto.scrapQty : before.scrapQty,
    };
    checkInterval(next.setupStartedAt, next.setupEndedAt, 'Attrezzaggio');
    checkInterval(next.workStartedAt, next.workEndedAt, 'Lavorazione');
    if (next.workStartedAt && next.workStartedAt.getTime() < next.setupStartedAt.getTime()) {
      throw new BadRequestException("La lavorazione non può iniziare prima dell'attrezzaggio.");
    }
    if (next.workEndedAt && !next.workStartedAt) throw new BadRequestException('Indicare anche l\'inizio della lavorazione.');
    if (next.status !== 'IN_PROGRESS') {
      if (next.workStartedAt ? !next.workEndedAt : !next.setupEndedAt) {
        throw new BadRequestException('Per chiudere la fase indicare l\'ora di fine (attrezzaggio o lavorazione).');
      }
      if (!next.setupEndedAt && next.workStartedAt) next.setupEndedAt = next.workStartedAt;
    }
    await em.update(WorkPhase, id, next);

    // Fermi ancora aperti di una fase chiusa: si chiudono alla fine della fase.
    if (next.status !== 'IN_PROGRESS') {
      const end = next.workEndedAt ?? next.setupEndedAt!;
      await em.query('UPDATE work_stop SET ended_at = GREATEST(started_at, $2), updated_at = now() WHERE work_phase_id = $1 AND ended_at IS NULL AND deleted_at IS NULL', [id, end]);
    }

    // Lavorazione pianificata collegata: una fase conclusa la conclude, una sospesa la lascia in lavorazione.
    if (before.scheduleItemId && next.status !== before.status) {
      const si = await em.findOne(ScheduleItem, { where: { id: before.scheduleItemId } });
      if (si) {
        await lockQueue(em, 'machine', si.machineId);
        if (next.status === 'COMPLETED') await em.update(ScheduleItem, si.id, { status: 'DONE', completedAt: next.workEndedAt ?? next.setupEndedAt ?? new Date() });
        else if (si.status !== 'DONE') await em.update(ScheduleItem, si.id, { status: 'IN_PROGRESS' });
        await renumberMachine(em, si.machineId);
      }
    }
    const changes: Record<string, { da: unknown; a: unknown }> = {};
    for (const k of Object.keys(next) as (keyof typeof next)[]) {
      const a = before[k] instanceof Date ? (before[k] as Date).toISOString() : before[k];
      const b = next[k] instanceof Date ? (next[k] as Date).toISOString() : next[k];
      if (a !== b) changes[k] = { da: a, a: b };
    }
    await writeAudit(em, 'work_phase', 'ACTION', id, changes, dto.reason ? `Correzione fase: ${dto.reason}` : 'Correzione fase dall\'ufficio');
  }

  async correctStop(phaseId: number, stopId: number, dto: CorrectWorkStopDto) {
    await this.dataSource.transaction(async (em) => {
      const stop = await em.findOne(WorkStop, { where: { id: stopId, workPhaseId: phaseId } });
      if (!stop) throw new NotFoundException(`Fermo non trovato (id ${stopId})`);
      const next = {
        startedAt: dto.startedAt !== undefined ? d(dto.startedAt)! : stop.startedAt,
        endedAt: dto.endedAt !== undefined ? d(dto.endedAt) : stop.endedAt,
        stopReasonId: dto.stopReasonId !== undefined ? dto.stopReasonId : stop.stopReasonId,
        machineStopped: dto.machineStopped ?? stop.machineStopped,
      };
      checkInterval(next.startedAt, next.endedAt, 'Fermo');
      if (next.stopReasonId && !(await em.findOne(StopReason, { where: { id: next.stopReasonId } }))) throw new BadRequestException('Causale di fermo non trovata');
      await em.update(WorkStop, stopId, next);
      await writeAudit(em, 'work_stop', 'ACTION', stopId, { prima: { startedAt: stop.startedAt, endedAt: stop.endedAt, stopReasonId: stop.stopReasonId, machineStopped: stop.machineStopped }, dopo: next },
        dto.reason ? `Correzione fermo: ${dto.reason}` : 'Correzione fermo dall\'ufficio');
    });
    return this.detail(phaseId);
  }

  async countOpen(): Promise<number> {
    return this.repo.count({ where: { status: 'IN_PROGRESS', deletedAt: IsNull() } });
  }
}

// ---------------------------------------------------------------------------
// Collaudi
// ---------------------------------------------------------------------------

@Injectable()
export class InspectionsService extends CrudService<Inspection> {
  private readonly timeZone: string;

  constructor(@InjectRepository(Inspection) repo: Repository<Inspection>, config: ConfigService) {
    super(repo, {
      label: 'Collaudo',
      relations: ['operator', 'machine', 'productionOrder', 'productionOrder.drawing', 'productionOrder.customerOrder', 'productionOrder.customerOrder.customer'],
      searchFields: ['productionOrderId', 'operator.lastName', 'operator.firstName', 'productionOrder.drawing.code', 'productionOrder.customerOrder.customer.name', 'notes'],
      sortable: ['id', 'startedAt', 'endedAt', 'goodQty', 'scrapQty', 'productionOrderId', 'operator.lastName'],
      filterable: ['productionOrderId', 'operatorId', 'machineId'],
      defaultSort: { field: 'startedAt', order: 'desc' },
    });
    this.timeZone = config.get<string>('timezone') ?? 'Europe/Rome';
  }

  protected override customizeList(qb: SelectQueryBuilder<Inspection>, query: ListQueryDto): void {
    const f = query.filter ?? {};
    periodFilter(qb, 'e.startedAt', f, this.timeZone);
    if (f.open === 'true') qb.andWhere('e.endedAt IS NULL');
    if (f.open === 'false') qb.andWhere('e.endedAt IS NOT NULL');
  }

  async correct(id: number, dto: CorrectInspectionDto) {
    const before = await this.findOne(id);
    const next = {
      startedAt: dto.startedAt !== undefined ? d(dto.startedAt)! : before.startedAt,
      endedAt: dto.endedAt !== undefined ? d(dto.endedAt) : before.endedAt,
      goodQty: dto.goodQty !== undefined ? dto.goodQty : before.goodQty,
      scrapQty: dto.scrapQty !== undefined ? dto.scrapQty : before.scrapQty,
      notes: dto.notes !== undefined ? dto.notes : before.notes,
    };
    checkInterval(next.startedAt, next.endedAt, 'Collaudo');
    await this.repo.manager.transaction(async (em) => {
      await em.update(Inspection, id, next);
      await writeAudit(em, 'inspection', 'ACTION', id, { prima: { startedAt: before.startedAt, endedAt: before.endedAt, goodQty: before.goodQty, scrapQty: before.scrapQty, notes: before.notes }, dopo: next },
        dto.reason ? `Correzione collaudo: ${dto.reason}` : 'Correzione collaudo dall\'ufficio');
    });
    return this.findOne(id);
  }
}

// ---------------------------------------------------------------------------
// Lavori extra
// ---------------------------------------------------------------------------

@Injectable()
export class ExtraActivityLogsService extends CrudService<ExtraActivityLog> {
  private readonly timeZone: string;

  constructor(@InjectRepository(ExtraActivityLog) repo: Repository<ExtraActivityLog>, config: ConfigService) {
    super(repo, {
      label: 'Lavoro extra',
      relations: ['operator', 'extraActivity', 'machine'],
      searchFields: ['operator.lastName', 'operator.firstName', 'extraActivity.name', 'machine.name'],
      sortable: ['id', 'startedAt', 'endedAt', 'operator.lastName', 'extraActivity.name', 'machine.name'],
      filterable: ['operatorId', 'extraActivityId', 'machineId'],
      defaultSort: { field: 'startedAt', order: 'desc' },
    });
    this.timeZone = config.get<string>('timezone') ?? 'Europe/Rome';
  }

  protected override customizeList(qb: SelectQueryBuilder<ExtraActivityLog>, query: ListQueryDto): void {
    const f = query.filter ?? {};
    periodFilter(qb, 'e.startedAt', f, this.timeZone);
    if (f.open === 'true') qb.andWhere('e.endedAt IS NULL');
    if (f.open === 'false') qb.andWhere('e.endedAt IS NOT NULL');
  }

  async correct(id: number, dto: CorrectExtraActivityLogDto) {
    const before = await this.findOne(id);
    const next = {
      startedAt: dto.startedAt !== undefined ? d(dto.startedAt)! : before.startedAt,
      endedAt: dto.endedAt !== undefined ? d(dto.endedAt) : before.endedAt,
      extraActivityId: dto.extraActivityId ?? before.extraActivityId,
      machineId: dto.machineId !== undefined ? dto.machineId : before.machineId,
    };
    checkInterval(next.startedAt, next.endedAt, 'Lavoro extra');
    const em = this.repo.manager;
    if (!(await em.findOne(ExtraActivity, { where: { id: next.extraActivityId } }))) throw new BadRequestException('Lavoro extra non trovato');
    if (next.machineId && !(await em.findOne(Machine, { where: { id: next.machineId } }))) throw new BadRequestException('Macchina non trovata');
    await em.transaction(async (tx) => {
      await tx.update(ExtraActivityLog, id, next);
      await writeAudit(tx, 'extra_activity_log', 'ACTION', id,
        { prima: { startedAt: before.startedAt, endedAt: before.endedAt, extraActivityId: before.extraActivityId, machineId: before.machineId }, dopo: next },
        dto.reason ? `Correzione lavoro extra: ${dto.reason}` : 'Correzione lavoro extra dall\'ufficio');
    });
    return this.findOne(id);
  }
}
