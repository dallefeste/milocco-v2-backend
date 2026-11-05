import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, IsNull, MoreThan, Not } from 'typeorm';
import { writeAudit } from '../../common/crud/crud.service';
import {
  CutQueueItem, Department, DrawingPart, ExtraActivity, ExtraActivityLog, Inspection, Machine, MachineType, Operator,
  OperatorSession, Part, ProductionOrder, ProductionOrderPart, ScheduleItem, StopReason, WorkPhase, WorkStop,
} from '../../entities';
import { BarStockService } from '../masterdata/bar-stock.service';
import { SettingsService } from '../settings/settings.service';
import { isResumed, mmToMeters } from './shopfloor.rules';
import type {
  BarMoveDto, ExtraStartDto, InspectionDataDto, InspectionStartDto, SetupStartDto, StopStartDto, SuspendDto, WorkEndDto,
} from './shopfloor.dto';

/** Chiavi dei lock applicativi (pg_advisory_xact_lock) per serializzare le azioni concorrenti. */
const LOCK = { machine: 5101, orderPart: 5102, operator: 5103 } as const;

/** Finestra (ore) entro cui un'attività aperta è considerata "in corso" sul tablet. */
export const RESUME_HOURS_SETTING = 'tablet_resume_max_hours';
export const DEFAULT_RESUME_HOURS = 168;

/**
 * Azioni del tablet di reparto. Ogni azione: una transazione, controllo dello stato, protezione dal doppio
 * invio (se l'attività esiste già viene restituita invece di crearne un'altra), messaggi in italiano.
 * Gli orari sono sempre quelli del server: il tablet non manda mai date.
 */
@Injectable()
export class ShopfloorActionsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly settings: SettingsService,
    private readonly barStock: BarStockService,
  ) {}

  private now(): Date {
    return new Date();
  }

  async resumeSince(): Promise<Date> {
    const hours = Number(await this.settings.get<number>(RESUME_HOURS_SETTING, DEFAULT_RESUME_HOURS)) || DEFAULT_RESUME_HOURS;
    return new Date(this.now().getTime() - hours * 3600_000);
  }

  private lock(em: EntityManager, kind: keyof typeof LOCK, id: number) {
    return em.query('SELECT pg_advisory_xact_lock($1, $2)', [LOCK[kind], id]);
  }

  // ---------------------------------------------------------------------------------------------
  // Controlli comuni
  // ---------------------------------------------------------------------------------------------

  private async machine(em: EntityManager, id: number): Promise<Machine & { machineType: MachineType }> {
    const machine = await em.getRepository(Machine).findOne({ where: { id } });
    if (!machine) throw new NotFoundException('Postazione non trovata: riconfigura il tablet');
    const type = await em.getRepository(MachineType).findOne({ where: { id: machine.machineTypeId }, withDeleted: true });
    return Object.assign(machine, { machineType: type ?? ({ isCutting: false, isInspection: false } as MachineType) });
  }

  async operator(em: EntityManager, id: number): Promise<Operator> {
    const op = await em.getRepository(Operator).findOne({ where: { id } });
    if (!op || !op.active) throw new BadRequestException('Operatore non attivo: scegli di nuovo l\'operatore');
    if (op.departmentId) {
      const dep = await em.getRepository(Department).findOne({ where: { id: op.departmentId }, withDeleted: true });
      if (dep && !dep.isProduction) throw new BadRequestException('L\'operatore non appartiene a un reparto di produzione');
    }
    return op;
  }

  private async openOrder(em: EntityManager, id: number): Promise<ProductionOrder> {
    const order = await em.getRepository(ProductionOrder).findOne({ where: { id } });
    if (!order) throw new NotFoundException(`Ordine di produzione N. ${id} non trovato`);
    if (order.status === 'COMPLETED') throw new ConflictException(`L'ordine N. ${id} è già archiviato`);
    return order;
  }

  private async phase(em: EntityManager, id: number): Promise<WorkPhase> {
    const phase = await em.getRepository(WorkPhase).findOne({ where: { id } });
    if (!phase) throw new NotFoundException('Fase non trovata');
    return phase;
  }

  private async openStops(em: EntityManager, phaseId: number): Promise<WorkStop[]> {
    return em.getRepository(WorkStop).find({ where: { workPhaseId: phaseId, endedAt: IsNull() } });
  }

  private async closeOpenStops(em: EntityManager, phaseId: number, at: Date): Promise<void> {
    const repo = em.getRepository(WorkStop);
    for (const stop of await this.openStops(em, phaseId)) {
      stop.endedAt = at;
      await repo.save(stop);
    }
  }

  private async markOrderStarted(em: EntityManager, order: ProductionOrder, at: Date): Promise<void> {
    if (order.status === 'TO_DO' || !order.startedAt) {
      if (order.status === 'TO_DO') order.status = 'IN_PROGRESS';
      order.startedAt = order.startedAt ?? at;
      await em.getRepository(ProductionOrder).save(order);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Sessione operatore
  // ---------------------------------------------------------------------------------------------

  async startSession(operatorId: number, machineId: number): Promise<OperatorSession> {
    return this.dataSource.transaction(async (em) => {
      await this.operator(em, operatorId);
      await this.machine(em, machineId);
      await this.lock(em, 'operator', operatorId);
      const repo = em.getRepository(OperatorSession);
      const existing = await repo.findOne({ where: { operatorId, machineId, endedAt: IsNull() }, order: { startedAt: 'DESC' } });
      if (existing && existing.startedAt > (await this.resumeSince())) return existing;
      // Una sessione rimasta aperta (tablet spento) si chiude quando lo stesso operatore rientra sulla postazione.
      if (existing) { existing.endedAt = this.now(); await repo.save(existing); }
      return repo.save(repo.create({ operatorId, machineId, startedAt: this.now(), endedAt: null }));
    });
  }

  async endSession(id: number): Promise<OperatorSession> {
    return this.dataSource.transaction(async (em) => {
      const repo = em.getRepository(OperatorSession);
      const session = await repo.findOne({ where: { id } });
      if (!session) throw new NotFoundException('Sessione non trovata');
      if (!session.endedAt) { session.endedAt = this.now(); await repo.save(session); }
      return session;
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Fasi: attrezzaggio, lavorazione, sospensione
  // ---------------------------------------------------------------------------------------------

  /**
   * Inizio attrezzaggio: crea la fase (numero progressivo per ordine+particolare, o lo stesso numero se è una
   * ripresa), la collega alla lavorazione pianificata della stessa macchina, porta ordine, lavorazione
   * pianificata e (su macchina di taglio) riga della coda di taglio in lavorazione.
   */
  async setupStart(dto: SetupStartDto): Promise<WorkPhase> {
    return this.dataSource.transaction(async (em) => {
      const at = this.now();
      const machine = await this.machine(em, dto.machineId);
      await this.operator(em, dto.operatorId);
      await this.lock(em, 'machine', dto.machineId);
      await this.lock(em, 'orderPart', dto.productionOrderId);
      const phases = em.getRepository(WorkPhase);

      // Doppio invio o fase già aperta dallo stesso operatore su questa macchina.
      const open = await phases.findOne({
        where: { machineId: dto.machineId, operatorId: dto.operatorId, status: 'IN_PROGRESS', setupStartedAt: MoreThan(await this.resumeSince()) },
        order: { id: 'DESC' },
      });
      if (open) {
        if (open.productionOrderId === dto.productionOrderId && open.partId === dto.partId) return open;
        throw new ConflictException(
          `Hai già una fase aperta su questa postazione (ordine N. ${open.productionOrderId}): concludila o sospendila prima di iniziarne un'altra`,
        );
      }

      const order = await this.openOrder(em, dto.productionOrderId);
      const part = await em.getRepository(Part).findOne({ where: { id: dto.partId }, withDeleted: true });
      if (!part) throw new NotFoundException('Particolare non trovato');
      const inOrder =
        (await em.getRepository(ProductionOrderPart).findOne({ where: { productionOrderId: order.id, partId: dto.partId } })) ??
        (await em.getRepository(DrawingPart).findOne({ where: { drawingId: order.drawingId, partId: dto.partId } }));
      if (!inOrder) throw new BadRequestException(`Il particolare ${part.internalCode} non fa parte dell'ordine N. ${order.id}`);

      const samePart = await phases.find({ where: { productionOrderId: order.id, partId: dto.partId } });
      let phaseNumber: number;
      let resumedFrom: WorkPhase | null = null;
      if (dto.resumeFromPhaseId) {
        resumedFrom = samePart.find((p) => p.id === dto.resumeFromPhaseId) ?? null;
        if (!resumedFrom) throw new BadRequestException('La fase da riprendere non appartiene a questo ordine e particolare');
        if (resumedFrom.status !== 'SUSPENDED') throw new ConflictException(`La fase numero ${resumedFrom.phaseNumber} non è sospesa`);
        if (isResumed(resumedFrom, samePart)) throw new ConflictException(`La fase numero ${resumedFrom.phaseNumber} è già stata ripresa`);
        phaseNumber = resumedFrom.phaseNumber;
      } else {
        phaseNumber = samePart.reduce((max, p) => Math.max(max, p.phaseNumber), 0) + 1;
      }

      // Collegamento alla lavorazione pianificata della stessa macchina, ordine e particolare non conclusa:
      // per una ripresa quella della fase sospesa, altrimenti la prima nella coda della macchina (A18).
      const schedRepo = em.getRepository(ScheduleItem);
      const candidates = await schedRepo.find({
        where: { machineId: dto.machineId, productionOrderId: order.id, partId: dto.partId, status: Not('DONE') },
        order: { position: 'ASC', id: 'ASC' },
      });
      const scheduleItem = candidates.find((s) => resumedFrom && s.id === resumedFrom.scheduleItemId) ?? candidates[0] ?? null;
      if (scheduleItem && scheduleItem.status !== 'IN_PROGRESS') {
        scheduleItem.status = 'IN_PROGRESS';
        await schedRepo.save(scheduleItem);
      }

      await this.markOrderStarted(em, order, at);

      if (machine.machineType.isCutting) {
        const cutRepo = em.getRepository(CutQueueItem);
        const cuts = await cutRepo.find({ where: { productionOrderId: order.id, partId: dto.partId, status: In(['WAITING', 'IN_PROGRESS']) } });
        for (const cut of cuts) {
          cut.status = 'IN_PROGRESS';
          cut.startedAt = cut.startedAt ?? at;
          await cutRepo.save(cut);
        }
      }

      const phase = await phases.save(
        phases.create({
          productionOrderId: order.id,
          partId: dto.partId,
          operatorId: dto.operatorId,
          machineId: dto.machineId,
          scheduleItemId: scheduleItem?.id ?? null,
          phaseNumber,
          resumedFromId: resumedFrom?.id ?? null,
          status: 'IN_PROGRESS',
          setupStartedAt: at,
          setupEndedAt: null,
          workStartedAt: null,
          workEndedAt: null,
          goodQty: null,
          scrapQty: null,
          avgUnitSeconds: null,
        }),
      );
      await writeAudit(em, 'work_phase', 'ACTION', phase.id, { phaseNumber, resumedFromId: phase.resumedFromId },
        `Tablet: inizio attrezzaggio fase ${phaseNumber} ordine N. ${order.id}`);
      return phase;
    });
  }

  async setupEnd(phaseId: number): Promise<WorkPhase> {
    return this.dataSource.transaction(async (em) => {
      const phase = await this.phase(em, phaseId);
      if (phase.status !== 'IN_PROGRESS') throw new ConflictException('La fase non è più in corso');
      if (phase.setupEndedAt) return phase; // doppio invio
      if ((await this.openStops(em, phase.id)).length) throw new ConflictException('C\'è un fermo in corso: chiudilo prima di finire l\'attrezzaggio');
      phase.setupEndedAt = this.now();
      return em.getRepository(WorkPhase).save(phase);
    });
  }

  async workStart(phaseId: number): Promise<WorkPhase> {
    return this.dataSource.transaction(async (em) => {
      const phase = await this.phase(em, phaseId);
      if (phase.status !== 'IN_PROGRESS') throw new ConflictException('La fase non è più in corso');
      if (!phase.setupEndedAt) throw new ConflictException('Prima concludi l\'attrezzaggio');
      if (phase.workStartedAt) return phase; // doppio invio
      phase.workStartedAt = this.now();
      return em.getRepository(WorkPhase).save(phase);
    });
  }

  /**
   * Fine lavorazione: fase conclusa con pezzi, lavorazione pianificata collegata conclusa, su macchina di
   * taglio riga della coda completata ed eventuale carico dell'avanzo di barra, tutto in una transazione.
   */
  async workEnd(phaseId: number, dto: WorkEndDto): Promise<WorkPhase> {
    return this.dataSource.transaction(async (em) => {
      const at = this.now();
      const phase = await this.phase(em, phaseId);
      if (phase.status === 'COMPLETED' && phase.goodQty === dto.goodQty && phase.scrapQty === dto.scrapQty) return phase; // doppio invio
      if (phase.status !== 'IN_PROGRESS') throw new ConflictException('La fase non è in lavorazione');
      if (!phase.workStartedAt) throw new ConflictException('La lavorazione non è ancora iniziata');
      await this.lock(em, 'machine', phase.machineId);
      await this.closeOpenStops(em, phase.id, at);
      phase.status = 'COMPLETED';
      phase.workEndedAt = at;
      phase.goodQty = dto.goodQty;
      phase.scrapQty = dto.scrapQty;
      await em.getRepository(WorkPhase).save(phase);

      if (phase.scheduleItemId) {
        const schedRepo = em.getRepository(ScheduleItem);
        const item = await schedRepo.findOne({ where: { id: phase.scheduleItemId } });
        if (item && item.status !== 'DONE') {
          item.status = 'DONE';
          item.completedAt = at;
          await schedRepo.save(item);
        }
      }

      const machine = await this.machine(em, phase.machineId);
      if (machine.machineType.isCutting && phase.partId) {
        const cutRepo = em.getRepository(CutQueueItem);
        const cuts = await cutRepo.find({ where: { productionOrderId: phase.productionOrderId, partId: phase.partId, status: In(['WAITING', 'IN_PROGRESS']) } });
        for (const cut of cuts) {
          cut.status = 'COMPLETED';
          cut.startedAt = cut.startedAt ?? phase.setupStartedAt;
          cut.completedAt = at;
          await cutRepo.save(cut);
        }
        if (dto.barReturnMm && dto.barReturnMm > 0) {
          const part = await em.getRepository(Part).findOne({ where: { id: phase.partId }, withDeleted: true });
          if (!part?.barTypeId) throw new BadRequestException('Il particolare non ha una tipologia di barra: impossibile caricare l\'avanzo');
          await this.barStock.load(part.barTypeId, mmToMeters(dto.barReturnMm), {
            manager: em, operatorId: phase.operatorId, productionOrderId: phase.productionOrderId, reason: 'Avanzo di taglio (tablet)',
          });
        }
      }
      await writeAudit(em, 'work_phase', 'ACTION', phase.id, { goodQty: dto.goodQty, scrapQty: dto.scrapQty },
        `Tablet: fine lavorazione fase ${phase.phaseNumber} ordine N. ${phase.productionOrderId}`);
      return phase;
    });
  }

  /** Sospende la fase: in lavorazione con i pezzi fatti, in attrezzaggio senza pezzi. */
  async suspend(phaseId: number, dto: SuspendDto): Promise<WorkPhase> {
    return this.dataSource.transaction(async (em) => this.suspendIn(em, phaseId, dto.goodQty, dto.scrapQty));
  }

  private async suspendIn(em: EntityManager, phaseId: number, goodQty?: number | null, scrapQty?: number | null): Promise<WorkPhase> {
    const at = this.now();
    const phase = await this.phase(em, phaseId);
    if (phase.status === 'SUSPENDED') return phase; // doppio invio
    if (phase.status !== 'IN_PROGRESS') throw new ConflictException('La fase è già conclusa');
    await this.closeOpenStops(em, phase.id, at);
    if (phase.workStartedAt) {
      if (goodQty === undefined || goodQty === null || scrapQty === undefined || scrapQty === null) {
        throw new BadRequestException('Per sospendere una lavorazione avviata inserisci i pezzi buoni e scartati');
      }
      phase.workEndedAt = at;
      phase.goodQty = goodQty;
      phase.scrapQty = scrapQty;
    } else {
      phase.setupEndedAt = phase.setupEndedAt ?? at;
    }
    phase.status = 'SUSPENDED';
    await em.getRepository(WorkPhase).save(phase);
    await writeAudit(em, 'work_phase', 'ACTION', phase.id, { goodQty: phase.goodQty, scrapQty: phase.scrapQty },
      `Tablet: fase ${phase.phaseNumber} ordine N. ${phase.productionOrderId} sospesa`);
    return phase;
  }

  async saveAvgTime(phaseId: number, avgUnitSeconds: number): Promise<WorkPhase> {
    return this.dataSource.transaction(async (em) => {
      const phase = await this.phase(em, phaseId);
      phase.avgUnitSeconds = Math.round(avgUnitSeconds * 100) / 100;
      return em.getRepository(WorkPhase).save(phase);
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Fermi macchina e pause operatore
  // ---------------------------------------------------------------------------------------------

  /**
   * Inizio fermo. Con la causale di fine giornata la fase viene sospesa subito (il fermo si apre e si chiude
   * nello stesso istante); a lavorazione avviata servono i pezzi buoni e scartati.
   */
  async stopStart(phaseId: number, dto: StopStartDto): Promise<{ stop: WorkStop; phase: WorkPhase; suspended: boolean }> {
    return this.dataSource.transaction(async (em) => {
      const at = this.now();
      const phase = await this.phase(em, phaseId);
      if (phase.status !== 'IN_PROGRESS') throw new ConflictException('La fase non è più in corso');
      const reason = await em.getRepository(StopReason).findOne({ where: { id: dto.stopReasonId } });
      if (!reason) throw new NotFoundException('Causale di fermo non trovata');
      if (!dto.machineStopped && !phase.workStartedAt) throw new BadRequestException('La pausa operatore è possibile solo a lavorazione avviata');
      const repo = em.getRepository(WorkStop);
      const open = (await this.openStops(em, phase.id))[0];
      if (open && !reason.endsWorkday) {
        if (open.stopReasonId === dto.stopReasonId) return { stop: open, phase, suspended: false }; // doppio invio
        throw new ConflictException('C\'è già un fermo in corso su questa fase');
      }
      if (reason.endsWorkday && phase.workStartedAt && (dto.goodQty == null || dto.scrapQty == null)) {
        throw new BadRequestException('Fine giornata: inserisci i pezzi buoni e scartati per sospendere la fase');
      }
      if (open) { open.endedAt = at; await repo.save(open); }
      const stop = await repo.save(repo.create({
        workPhaseId: phase.id, stopReasonId: reason.id, startedAt: at, endedAt: reason.endsWorkday ? at : null,
        machineStopped: dto.machineStopped,
      }));
      if (reason.endsWorkday) {
        const suspended = await this.suspendIn(em, phase.id, dto.goodQty, dto.scrapQty);
        return { stop, phase: suspended, suspended: true };
      }
      return { stop, phase, suspended: false };
    });
  }

  async stopEnd(stopId: number): Promise<WorkStop> {
    return this.dataSource.transaction(async (em) => {
      const repo = em.getRepository(WorkStop);
      const stop = await repo.findOne({ where: { id: stopId } });
      if (!stop) throw new NotFoundException('Fermo non trovato');
      if (stop.endedAt) return stop; // doppio invio
      stop.endedAt = this.now();
      return repo.save(stop);
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Lavori extra
  // ---------------------------------------------------------------------------------------------

  async extraStart(dto: ExtraStartDto): Promise<ExtraActivityLog> {
    return this.dataSource.transaction(async (em) => {
      await this.operator(em, dto.operatorId);
      await this.lock(em, 'operator', dto.operatorId);
      const activity = await em.getRepository(ExtraActivity).findOne({ where: { id: dto.extraActivityId } });
      if (!activity) throw new NotFoundException('Lavoro extra non trovato');
      const repo = em.getRepository(ExtraActivityLog);
      const open = await repo.findOne({
        where: { operatorId: dto.operatorId, endedAt: IsNull(), startedAt: MoreThan(await this.resumeSince()) },
        order: { id: 'DESC' },
      });
      if (open) {
        if (open.extraActivityId === dto.extraActivityId) return open;
        throw new ConflictException('Hai già un lavoro extra in corso: terminalo prima di iniziarne un altro');
      }
      return repo.save(repo.create({
        operatorId: dto.operatorId, extraActivityId: activity.id, machineId: dto.machineId ?? null, startedAt: this.now(), endedAt: null,
      }));
    });
  }

  async extraEnd(id: number): Promise<ExtraActivityLog> {
    return this.dataSource.transaction(async (em) => {
      const repo = em.getRepository(ExtraActivityLog);
      const log = await repo.findOne({ where: { id } });
      if (!log) throw new NotFoundException('Lavoro extra non trovato');
      if (log.endedAt) return log;
      log.endedAt = this.now();
      return repo.save(log);
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Collaudo e archiviazione
  // ---------------------------------------------------------------------------------------------

  async inspectionStart(dto: InspectionStartDto): Promise<Inspection> {
    return this.dataSource.transaction(async (em) => {
      await this.operator(em, dto.operatorId);
      await this.machine(em, dto.machineId);
      await this.lock(em, 'operator', dto.operatorId);
      const repo = em.getRepository(Inspection);
      const open = await repo.findOne({
        where: { operatorId: dto.operatorId, machineId: dto.machineId, endedAt: IsNull(), startedAt: MoreThan(await this.resumeSince()) },
        order: { id: 'DESC' },
      });
      if (open) {
        if (open.productionOrderId === dto.productionOrderId) return open;
        throw new ConflictException(`Hai già un collaudo in corso (ordine N. ${open.productionOrderId}): concludilo prima`);
      }
      const order = await this.openOrder(em, dto.productionOrderId);
      await this.markOrderStarted(em, order, this.now());
      const inspection = await repo.save(repo.create({
        productionOrderId: order.id, operatorId: dto.operatorId, machineId: dto.machineId, startedAt: this.now(),
        endedAt: null, goodQty: null, scrapQty: null, notes: null,
      }));
      await writeAudit(em, 'inspection', 'ACTION', inspection.id, null, `Tablet: inizio collaudo ordine N. ${order.id}`);
      return inspection;
    });
  }

  async inspectionEnd(id: number): Promise<Inspection> {
    return this.dataSource.transaction(async (em) => {
      const repo = em.getRepository(Inspection);
      const inspection = await repo.findOne({ where: { id } });
      if (!inspection) throw new NotFoundException('Collaudo non trovato');
      if (inspection.endedAt) return inspection;
      inspection.endedAt = this.now();
      return repo.save(inspection);
    });
  }

  /** Pezzi e note del collaudo. Note vuote → nessuna nota (mai il testo "undefined", A6). */
  async inspectionData(id: number, dto: InspectionDataDto): Promise<Inspection> {
    return this.dataSource.transaction(async (em) => {
      const repo = em.getRepository(Inspection);
      const inspection = await repo.findOne({ where: { id } });
      if (!inspection) throw new NotFoundException('Collaudo non trovato');
      inspection.endedAt = inspection.endedAt ?? this.now();
      inspection.goodQty = dto.goodQty;
      inspection.scrapQty = dto.scrapQty;
      const notes = typeof dto.notes === 'string' ? dto.notes.trim() : '';
      inspection.notes = notes && notes !== 'undefined' && notes !== 'null' ? notes : null;
      const saved = await repo.save(inspection);
      await writeAudit(em, 'inspection', 'ACTION', id, { goodQty: dto.goodQty, scrapQty: dto.scrapQty },
        `Tablet: dati collaudo ordine N. ${inspection.productionOrderId}`);
      return saved;
    });
  }

  /**
   * Archivia l'ordine: completato con data, lavorazioni pianificate aperte concluse, righe di taglio non
   * iniziate eliminate logicamente (le altre restano come storico). Nessuna cancellazione fisica.
   */
  async archiveOrder(orderId: number): Promise<ProductionOrder> {
    return this.dataSource.transaction(async (em) => {
      const at = this.now();
      const repo = em.getRepository(ProductionOrder);
      const order = await repo.findOne({ where: { id: orderId } });
      if (!order) throw new NotFoundException(`Ordine di produzione N. ${orderId} non trovato`);
      if (order.status === 'COMPLETED') return order; // doppio invio
      order.status = 'COMPLETED';
      order.completedAt = at;
      order.startedAt = order.startedAt ?? at;
      await repo.save(order);
      const schedRepo = em.getRepository(ScheduleItem);
      for (const item of await schedRepo.find({ where: { productionOrderId: orderId, status: Not('DONE') } })) {
        item.status = 'DONE';
        item.completedAt = at;
        await schedRepo.save(item);
      }
      const cutRepo = em.getRepository(CutQueueItem);
      const waiting = await cutRepo.find({ where: { productionOrderId: orderId, status: 'WAITING' } });
      if (waiting.length) await cutRepo.softDelete(waiting.map((c) => c.id));
      await writeAudit(em, 'production_order', 'ACTION', orderId, { removedCutRows: waiting.length },
        `Tablet: ordine N. ${orderId} archiviato dal collaudo`);
      return order;
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Magazzino barre
  // ---------------------------------------------------------------------------------------------

  /** Carico o scarico dal tablet tramite il magazzino barre. */
  async moveBars(barTypeId: number, dto: BarMoveDto): Promise<{ meters: number; warnings: string[] }> {
    await this.dataSource.transaction((em) => this.operator(em, dto.operatorId));
    const opts = {
      operatorId: dto.operatorId,
      productionOrderId: dto.productionOrderId ?? null,
      reason: dto.reason ?? (dto.kind === 'LOAD' ? 'Carico da tablet' : 'Scarico da tablet'),
    };
    const meters = mmToMeters(dto.mm);
    const r = dto.kind === 'LOAD' ? await this.barStock.load(barTypeId, meters, opts) : await this.barStock.unload(barTypeId, meters, opts);
    return { meters: r.metersAfter, warnings: r.warnings };
  }
}
