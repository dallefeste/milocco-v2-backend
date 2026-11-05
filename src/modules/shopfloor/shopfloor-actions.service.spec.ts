import { BadRequestException, ConflictException } from '@nestjs/common';
import { DataSource, FindOperator } from 'typeorm';
import {
  BarStock, BarStockMovement, BarType, CutQueueItem, Department, DrawingPart, Inspection, Machine, MachineType, Operator,
  Part, ProductionOrder, ProductionOrderPart, ScheduleItem, StopReason, WorkPhase, WorkStop,
} from '../../entities';
import type { BarStockService } from '../masterdata/bar-stock.service';
import { SettingsService } from '../settings/settings.service';
import { ShopfloorActionsService } from './shopfloor-actions.service';

/** Repository in memoria: supporta i metodi e gli operatori di ricerca usati dal servizio. */
class FakeRepo<T extends { id: number; deletedAt?: Date | null }> {
  rows: T[] = [];
  private seq = 0;
  constructor(private readonly cls: new () => T) {}

  private matches(row: any, where: Record<string, unknown> = {}): boolean {
    return Object.entries(where).every(([k, cond]) => test(row[k], cond));
  }
  private visible(o?: { withDeleted?: boolean }) {
    return this.rows.filter((r) => o?.withDeleted || !r.deletedAt);
  }
  create(data: Partial<T>): T {
    return Object.assign(new this.cls(), data);
  }
  async save(e: T): Promise<T> {
    if (!e.id) {
      e.id = ++this.seq;
      this.rows.push(e);
    } else if (!this.rows.includes(e)) {
      this.rows = this.rows.filter((r) => r.id !== e.id).concat(e);
    }
    return e;
  }
  async find(o: { where?: any; order?: Record<string, 'ASC' | 'DESC'>; withDeleted?: boolean } = {}): Promise<T[]> {
    const list = this.visible(o).filter((r) => this.matches(r, o.where));
    const [key, dir] = Object.entries(o.order ?? {})[0] ?? [];
    if (key) list.sort((a: any, b: any) => (a[key] > b[key] ? 1 : a[key] < b[key] ? -1 : 0) * (dir === 'DESC' ? -1 : 1));
    return list;
  }
  async findOne(o: { where?: any; order?: Record<string, 'ASC' | 'DESC'>; withDeleted?: boolean }): Promise<T | null> {
    return (await this.find(o))[0] ?? null;
  }
  async softDelete(ids: number[]) {
    for (const r of this.rows) if (ids.includes(r.id)) r.deletedAt = new Date();
  }
  seed(data: Partial<T>): T {
    const e = this.create(data);
    if (!e.id) e.id = ++this.seq;
    else this.seq = Math.max(this.seq, e.id);
    this.rows.push(e);
    return e;
  }
}

function test(value: unknown, cond: unknown): boolean {
  if (cond instanceof FindOperator) {
    const op = cond as FindOperator<any>;
    switch (op.type) {
      case 'isNull': return value === null || value === undefined;
      case 'not': return !test(value, op.value);
      case 'in': return (op.value as unknown[]).includes(value);
      case 'moreThan': return (value as any) > op.value;
      default: throw new Error(`Operatore non gestito nel test: ${op.type}`);
    }
  }
  return value === cond;
}

function setup() {
  const repos = new Map<unknown, FakeRepo<any>>();
  const repo = <T extends { id: number }>(cls: new () => T): FakeRepo<T> => {
    if (!repos.has(cls)) repos.set(cls, new FakeRepo(cls));
    return repos.get(cls)!;
  };
  const em = { getRepository: repo, query: jest.fn(async () => []) };
  const dataSource = { transaction: (cb: (m: unknown) => unknown) => cb(em) } as unknown as DataSource;
  const settings = { get: async (_k: string, fallback: unknown) => fallback } as unknown as SettingsService;
  // Magazzino barre simulato: aggiorna la giacenza e registra il movimento come il servizio reale.
  const barStock = {
    load: jest.fn(async (barTypeId: number, meters: number, opts: Record<string, unknown>) => {
      const stock = repo(BarStock).rows.find((s) => s.barTypeId === barTypeId)!;
      stock.meters = Math.round((stock.meters + meters) * 1000) / 1000;
      await repo(BarStockMovement).save(repo(BarStockMovement).create({
        barTypeId, kind: 'LOAD', meters, metersAfter: stock.meters,
        operatorId: opts.operatorId as number, productionOrderId: opts.productionOrderId as number,
      }));
      return { metersAfter: stock.meters, warnings: [] };
    }),
    unload: jest.fn(),
  };
  const service = new ShopfloorActionsService(dataSource, settings, barStock as unknown as BarStockService);

  // Dati di base: macchina di taglio, operatore di produzione, ordine con un particolare a barra.
  repo(Department).seed({ id: 1, name: 'Produzione', isProduction: true });
  repo(Operator).seed({ id: 1, firstName: 'Mario', lastName: 'Rossi', active: true, departmentId: 1 });
  repo(Operator).seed({ id: 2, firstName: 'Luca', lastName: 'Bianchi', active: true, departmentId: 1 });
  repo(MachineType).seed({ id: 1, name: 'Sega', isCutting: true, isInspection: false });
  repo(MachineType).seed({ id: 2, name: 'Tornio', isCutting: false, isInspection: false });
  repo(Machine).seed({ id: 10, name: 'SEGA', machineTypeId: 1 });
  repo(Machine).seed({ id: 11, name: 'TORNIO 1', machineTypeId: 2 });
  repo(BarType).seed({ id: 5, code: 'MPFE01TOT50', shape: 'TO', dimensions: '50' });
  repo(BarStock).seed({ id: 1, barTypeId: 5, meters: 10 });
  repo(Part).seed({ id: 100, internalCode: 'P-100', barCut: true, barTypeId: 5 });
  repo(Part).seed({ id: 200, internalCode: 'P-200', barCut: false, barTypeId: null });
  repo(ProductionOrder).seed({ id: 7, customerOrderId: 1, drawingId: 3, quantity: 10, status: 'TO_DO', startedAt: null, completedAt: null });
  repo(ProductionOrderPart).seed({ id: 1, productionOrderId: 7, partId: 100, quantityPerUnit: 2 });
  repo(DrawingPart).seed({ id: 1, drawingId: 3, partId: 200, quantity: 1 });
  repo(ScheduleItem).seed({ id: 50, productionOrderId: 7, partId: 100, machineId: 10, position: 1, status: 'OPEN', completedAt: null });
  repo(CutQueueItem).seed({ id: 60, productionOrderId: 7, partId: 100, position: 1, status: 'WAITING', startedAt: null, completedAt: null });
  repo(CutQueueItem).seed({ id: 61, productionOrderId: 7, partId: 200, position: 2, status: 'WAITING', startedAt: null, completedAt: null });
  repo(StopReason).seed({ id: 1, name: 'Guasto macchina', endsWorkday: false });
  repo(StopReason).seed({ id: 9, name: 'Fine giornata lavorativa', endsWorkday: true });
  return { service, repo, em, barStock };
}

describe('ShopfloorActionsService: flusso di taglio completo', () => {
  it('attrezzaggio → lavorazione → fine con avanzo barra', async () => {
    const { service, repo, em, barStock } = setup();
    const start = { productionOrderId: 7, partId: 100, machineId: 10, operatorId: 1 };
    const phase = await service.setupStart(start);
    expect(phase).toMatchObject({ phaseNumber: 1, status: 'IN_PROGRESS', scheduleItemId: 50, resumedFromId: null });
    expect(repo(ProductionOrder).rows[0]).toMatchObject({ status: 'IN_PROGRESS' });
    expect(repo(ProductionOrder).rows[0].startedAt).toBeInstanceOf(Date);
    expect(repo(ScheduleItem).rows[0].status).toBe('IN_PROGRESS');
    expect(repo(CutQueueItem).rows.find((c) => c.id === 60)!.status).toBe('IN_PROGRESS');

    // Doppio tocco: stessa fase, nessuna riga in più.
    expect((await service.setupStart(start)).id).toBe(phase.id);
    expect(repo(WorkPhase).rows).toHaveLength(1);

    await expect(service.workEnd(phase.id, { operatorId: 1, goodQty: 1, scrapQty: 0 })).rejects.toBeInstanceOf(ConflictException);
    await expect(service.workStart(phase.id)).rejects.toThrow('Prima concludi l\'attrezzaggio');
    await service.setupEnd(phase.id);
    await service.workStart(phase.id);
    const done = await service.workEnd(phase.id, { operatorId: 1, goodQty: 19, scrapQty: 1, barReturnMm: 120 });

    expect(done).toMatchObject({ status: 'COMPLETED', goodQty: 19, scrapQty: 1 });
    expect(done.workEndedAt).toBeInstanceOf(Date);
    expect(repo(ScheduleItem).rows[0]).toMatchObject({ status: 'DONE' });
    expect(repo(ScheduleItem).rows[0].completedAt).toBeInstanceOf(Date);
    const cut = repo(CutQueueItem).rows.find((c) => c.id === 60)!;
    expect(cut.status).toBe('COMPLETED');
    expect(cut.completedAt).toBeInstanceOf(Date);
    expect(repo(BarStock).rows[0].meters).toBeCloseTo(10.12);
    expect(repo(BarStockMovement).rows[0]).toMatchObject({ kind: 'LOAD', meters: 0.12, operatorId: 1, productionOrderId: 7, metersAfter: 10.12 });
    // Carico nella stessa transazione della fine lavorazione.
    expect(barStock.load.mock.calls[0][2]).toMatchObject({ manager: em, operatorId: 1, productionOrderId: 7 });

    // Secondo invio della fine lavorazione: nessun errore, nessun doppio carico.
    await service.workEnd(phase.id, { operatorId: 1, goodQty: 19, scrapQty: 1, barReturnMm: 120 });
    expect(repo(BarStockMovement).rows).toHaveLength(1);
  });

  it('sospensione, ripresa con lo stesso numero di fase e fine giornata', async () => {
    const { service, repo } = setup();
    const start = { productionOrderId: 7, partId: 200, machineId: 11, operatorId: 2 };
    const first = await service.setupStart(start);
    expect(first.scheduleItemId).toBeNull();
    await service.setupEnd(first.id);
    await service.workStart(first.id);
    await expect(service.suspend(first.id, { operatorId: 2 })).rejects.toBeInstanceOf(BadRequestException);
    const suspended = await service.suspend(first.id, { operatorId: 2, goodQty: 3, scrapQty: 0 });
    expect(suspended).toMatchObject({ status: 'SUSPENDED', goodQty: 3 });

    const resumed = await service.setupStart({ ...start, resumeFromPhaseId: first.id });
    expect(resumed).toMatchObject({ phaseNumber: 1, resumedFromId: first.id });

    // Fermo con causale di fine giornata in attrezzaggio: la fase viene sospesa subito, il fermo è chiuso.
    const r = await service.stopStart(resumed.id, { operatorId: 2, stopReasonId: 9, machineStopped: true });
    expect(r.suspended).toBe(true);
    expect(r.phase.status).toBe('SUSPENDED');
    expect(repo(WorkStop).rows[0].endedAt).toBeInstanceOf(Date);

    // La prima fase è già stata ripresa: non si può riprendere di nuovo.
    await expect(service.setupStart({ ...start, resumeFromPhaseId: first.id })).rejects.toThrow('già stata ripresa');
    // Una fase nuova prende il numero successivo.
    expect((await service.setupStart(start)).phaseNumber).toBe(2);
  });

  it('pausa operatore solo a lavorazione avviata, fine giornata in lavorazione chiede i pezzi', async () => {
    const { service } = setup();
    const phase = await service.setupStart({ productionOrderId: 7, partId: 200, machineId: 11, operatorId: 1 });
    await expect(service.stopStart(phase.id, { operatorId: 1, stopReasonId: 1, machineStopped: false })).rejects.toBeInstanceOf(BadRequestException);
    const stop = await service.stopStart(phase.id, { operatorId: 1, stopReasonId: 1, machineStopped: true });
    expect((await service.stopStart(phase.id, { operatorId: 1, stopReasonId: 1, machineStopped: true })).stop.id).toBe(stop.stop.id);
    await expect(service.setupEnd(phase.id)).rejects.toThrow('fermo in corso');
    await service.stopEnd(stop.stop.id);
    await service.setupEnd(phase.id);
    await service.workStart(phase.id);
    await expect(service.stopStart(phase.id, { operatorId: 1, stopReasonId: 9, machineStopped: true })).rejects.toThrow('pezzi');
    const r = await service.stopStart(phase.id, { operatorId: 1, stopReasonId: 9, machineStopped: true, goodQty: 4, scrapQty: 1 });
    expect(r.phase).toMatchObject({ status: 'SUSPENDED', goodQty: 4, scrapQty: 1 });
  });

  it('un operatore non apre due fasi diverse sulla stessa postazione', async () => {
    const { service } = setup();
    await service.setupStart({ productionOrderId: 7, partId: 200, machineId: 11, operatorId: 1 });
    await expect(service.setupStart({ productionOrderId: 7, partId: 100, machineId: 11, operatorId: 1 })).rejects.toBeInstanceOf(ConflictException);
  });

  it('collaudo: note vuote salvate come nessuna nota; archiviazione senza cancellazioni fisiche', async () => {
    const { service, repo } = setup();
    const insp = await service.inspectionStart({ productionOrderId: 7, operatorId: 1, machineId: 11 });
    expect((await service.inspectionStart({ productionOrderId: 7, operatorId: 1, machineId: 11 })).id).toBe(insp.id);
    await service.inspectionEnd(insp.id);
    const saved = await service.inspectionData(insp.id, { goodQty: 10, scrapQty: 0, notes: '   ' });
    expect(saved.notes).toBeNull();
    expect((await service.inspectionData(insp.id, { goodQty: 10, scrapQty: 0, notes: 'Anodizzare & lucidare #2' })).notes).toBe('Anodizzare & lucidare #2');

    repo(CutQueueItem).rows.find((c) => c.id === 60)!.status = 'COMPLETED';
    const order = await service.archiveOrder(7);
    expect(order).toMatchObject({ status: 'COMPLETED' });
    expect(order.completedAt).toBeInstanceOf(Date);
    expect(repo(ScheduleItem).rows[0].status).toBe('DONE');
    expect(repo(CutQueueItem).rows).toHaveLength(2);
    expect(repo(CutQueueItem).rows.find((c) => c.id === 60)!.deletedAt ?? null).toBeNull();
    expect(repo(CutQueueItem).rows.find((c) => c.id === 61)!.deletedAt).toBeInstanceOf(Date);
    await expect(service.setupStart({ productionOrderId: 7, partId: 100, machineId: 10, operatorId: 2 })).rejects.toThrow('già archiviato');
  });
});
