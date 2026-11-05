import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Part, PartCycleStep, QuotePart } from '../../entities';

const r2 = (v: number) => Math.round(v * 100) / 100;
const secs = (from: Date | string | null, to: Date | string | null) =>
  from && to ? Math.max(0, Math.round((new Date(to).getTime() - new Date(from).getTime()) / 1000)) : 0;
const t = (v: Date | string | null) => (v ? new Date(v).getTime() : null);

export interface TypeTimes {
  /** Attrezzaggio netto totale dell'ordine (secondi). */
  setupSeconds: number;
  /** Lavorazione netta per pezzo (secondi). */
  unitSeconds: number;
  /** Lavorazione netta totale (secondi). */
  workSeconds: number;
  phases: number;
}

/**
 * Storici di un particolare: tempi reali negli ordini di produzione completati (03-report §5.2,
 * 01-commerciale §1.5) e costi nei preventivi (03-report §5.3, formule di 01-commerciale §1.4).
 */
@Injectable()
export class PartHistoryService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  private async loadPart(id: number): Promise<Part> {
    const part = await this.dataSource.getRepository(Part).findOne({
      where: { id },
      relations: { material: true, supplier: true },
      withDeleted: true,
    });
    if (!part) throw new NotFoundException(`Particolare non trovato (id ${id})`);
    return part;
  }

  /**
   * Tempi reali per ordine di produzione completato e per tipologia macchina.
   * - Ordini non eliminati, completati, il cui disegno contiene il particolare (o che hanno il particolare tra i propri).
   * - Pezzi = quantità ordine × quantità del particolare per unità (quella copiata nell'ordine, altrimenti quella del disegno).
   * - Per ogni fase non eliminata: attrezzaggio = fine − inizio, lavorazione = fine − inizio; un fermo concluso con macchina
   *   ferma interamente dentro la lavorazione si toglie dalla lavorazione, altrimenti se è interamente dentro l'attrezzaggio
   *   si toglie dall'attrezzaggio.
   * - Per tipologia: attrezzaggio = somma (totale ordine), lavorazione per pezzo = somma lavorazioni / pezzi.
   * - Ordini senza fasi o con pezzi = 0 sono saltati.
   */
  async timeHistory(partId: number) {
    const part = await this.loadPart(partId);
    const orders: {
      id: number; quantity: number; qty_per_unit: string | null; completed_at: Date | null; customer_order_id: number;
      customer_order_code: string | null; order_date: Date | null; customer_name: string | null;
      drawing_id: number; drawing_code: string | null; drawing_revision: string | null;
    }[] = await this.dataSource.query(
      `SELECT po.id, po.quantity, po.completed_at, po.customer_order_id, po.drawing_id,
              COALESCE(
                (SELECT sum(pop.quantity_per_unit) FROM production_order_part pop WHERE pop.production_order_id = po.id AND pop.part_id = $1),
                (SELECT sum(dp.quantity) FROM drawing_part dp WHERE dp.drawing_id = po.drawing_id AND dp.part_id = $1)
              ) AS qty_per_unit,
              co.code AS customer_order_code, co.order_date, c.name AS customer_name,
              d.code AS drawing_code, d.revision AS drawing_revision
         FROM production_order po
         LEFT JOIN customer_order co ON co.id = po.customer_order_id
         LEFT JOIN customer c ON c.id = co.customer_id
         LEFT JOIN drawing d ON d.id = po.drawing_id
        WHERE po.deleted_at IS NULL AND po.status = 'COMPLETED'
          AND (EXISTS (SELECT 1 FROM drawing_part dp WHERE dp.drawing_id = po.drawing_id AND dp.part_id = $1)
               OR EXISTS (SELECT 1 FROM production_order_part pop WHERE pop.production_order_id = po.id AND pop.part_id = $1))`,
      [partId],
    );
    const orderIds = orders.map((o) => o.id);
    const phases: {
      id: number; production_order_id: number; machine_type_id: number;
      setup_started_at: Date | null; setup_ended_at: Date | null; work_started_at: Date | null; work_ended_at: Date | null;
    }[] = orderIds.length
      ? await this.dataSource.query(
          `SELECT wp.id, wp.production_order_id, m.machine_type_id, wp.setup_started_at, wp.setup_ended_at, wp.work_started_at, wp.work_ended_at
             FROM work_phase wp JOIN machine m ON m.id = wp.machine_id
            WHERE wp.part_id = $1 AND wp.deleted_at IS NULL AND wp.production_order_id = ANY($2)`,
          [partId, orderIds],
        )
      : [];
    const phaseIds = phases.map((p) => p.id);
    const stops: { work_phase_id: number; started_at: Date; ended_at: Date; machine_stopped: boolean }[] = phaseIds.length
      ? await this.dataSource.query(
          `SELECT work_phase_id, started_at, ended_at, machine_stopped FROM work_stop
            WHERE deleted_at IS NULL AND ended_at IS NOT NULL AND work_phase_id = ANY($1)`,
          [phaseIds],
        )
      : [];
    const stopsByPhase = new Map<number, typeof stops>();
    for (const s of stops) stopsByPhase.set(s.work_phase_id, [...(stopsByPhase.get(s.work_phase_id) ?? []), s]);

    // Tempi netti per fase.
    const byOrder = new Map<number, Map<number, { setup: number; work: number; phases: number }>>();
    for (const p of phases) {
      let setup = secs(p.setup_started_at, p.setup_ended_at);
      let work = secs(p.work_started_at, p.work_ended_at);
      const [ss, se, ws, we] = [t(p.setup_started_at), t(p.setup_ended_at), t(p.work_started_at), t(p.work_ended_at)];
      for (const s of stopsByPhase.get(p.id) ?? []) {
        const a = t(s.started_at)!;
        const b = t(s.ended_at)!;
        const dur = Math.max(0, Math.round((b - a) / 1000));
        if (s.machine_stopped && ws !== null && we !== null && a >= ws && b <= we) work -= dur;
        else if (ss !== null && se !== null && a >= ss && b <= se) setup -= dur;
      }
      const types = byOrder.get(p.production_order_id) ?? new Map();
      const acc = types.get(p.machine_type_id) ?? { setup: 0, work: 0, phases: 0 };
      acc.setup += Math.max(0, setup);
      acc.work += Math.max(0, work);
      acc.phases += 1;
      types.set(p.machine_type_id, acc);
      byOrder.set(p.production_order_id, types);
    }

    const usedTypes = new Set<number>();
    const rows = orders
      .map((o) => {
        const pieces = Number(o.quantity) * Number(o.qty_per_unit ?? 0);
        const types = byOrder.get(o.id);
        if (!types || pieces <= 0) return null;
        const times: Record<number, TypeTimes> = {};
        for (const [typeId, acc] of types) {
          usedTypes.add(typeId);
          times[typeId] = { setupSeconds: acc.setup, workSeconds: acc.work, unitSeconds: Math.round(acc.work / pieces), phases: acc.phases };
        }
        return {
          productionOrderId: o.id,
          customerOrderId: o.customer_order_id,
          customerOrderCode: o.customer_order_code,
          customerOrderDate: o.order_date,
          customerName: o.customer_name,
          drawing: { id: o.drawing_id, code: o.drawing_code, revision: o.drawing_revision },
          quantity: Number(o.quantity),
          quantityPerUnit: Number(o.qty_per_unit),
          pieces,
          completedAt: o.completed_at,
          times,
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .sort((a, b) => (t(b.customerOrderDate) ?? 0) - (t(a.customerOrderDate) ?? 0) || b.productionOrderId - a.productionOrderId);

    // Ciclo previsto (per confronto) e tipologie da mostrare come colonne.
    const cycle = await this.dataSource.getRepository(PartCycleStep).find({ where: { partId }, order: { sequence: 'ASC', id: 'ASC' } });
    const planned: Record<number, { setupSeconds: number; unitSeconds: number }> = {};
    for (const s of cycle) {
      usedTypes.add(s.machineTypeId);
      const p = (planned[s.machineTypeId] ??= { setupSeconds: 0, unitSeconds: 0 });
      p.setupSeconds += s.setupSeconds;
      p.unitSeconds += s.unitSeconds;
    }
    const machineTypes: { id: number; name: string }[] = usedTypes.size
      ? await this.dataSource.query('SELECT id, name FROM machine_type WHERE id = ANY($1) ORDER BY sort_order, name', [[...usedTypes]])
      : [];

    // Medie tra gli ordini (sintesi assente nel sistema precedente).
    const averages: Record<number, { setupSeconds: number; unitSeconds: number; orders: number; totalPieces: number; weightedUnitSeconds: number }> = {};
    for (const mt of machineTypes) {
      const withType = rows.filter((r) => r.times[mt.id]);
      if (!withType.length) continue;
      const totalPieces = withType.reduce((s, r) => s + r.pieces, 0);
      averages[mt.id] = {
        orders: withType.length,
        setupSeconds: Math.round(withType.reduce((s, r) => s + r.times[mt.id].setupSeconds, 0) / withType.length),
        unitSeconds: Math.round(withType.reduce((s, r) => s + r.times[mt.id].unitSeconds, 0) / withType.length),
        totalPieces,
        weightedUnitSeconds: Math.round(withType.reduce((s, r) => s + r.times[mt.id].workSeconds, 0) / totalPieces),
      };
    }

    return {
      part: { id: part.id, internalCode: part.internalCode, name: part.name, dimensions: part.dimensions, deleted: !!part.deletedAt },
      machineTypes,
      planned,
      orders: rows,
      averages,
    };
  }

  /**
   * Costi del particolare in ogni preventivo non eliminato che lo contiene (righe non eliminate), per pezzo:
   * - materiale = peso × prezzo/kg copiato nella riga (peso copiato nella riga, altrimenti quello del particolare);
   * - trattamenti = kg × €/kg oppure dm² × €/dm² (unità corrette; grandezze copiate nella riga se presenti);
   * - fasi = Σ (programmazione + attrezzaggio) × €/h / (3600 × Q) + lavorazione × €/h / 3600;
   * - CAM = tempo CAM × €/min / (60 × Q);
   * - totale = materiale + trattamenti + fasi + CAM (senza ricarichi).
   * Q = quantità da produrre; se è 0 si usa la quantità ordinata, se anche questa è 0 si usa 1.
   */
  async quoteHistory(partId: number) {
    const part = await this.loadPart(partId);
    const rows = await this.dataSource.getRepository(QuotePart).find({
      where: { partId },
      relations: { quote: { customer: true }, phases: { machineType: true }, treatments: { treatment: true } },
    });
    const items = rows
      .filter((qp) => qp.quote && !qp.quote.deletedAt)
      .map((qp) => {
        const q = qp.productionQuantity > 0 ? qp.productionQuantity : qp.quantity > 0 ? qp.quantity : 1;
        const weight = qp.weightKg ?? part.weightKg;
        const kg = qp.treatmentKg ?? part.treatmentKg ?? 0;
        const dm2 = qp.treatmentDm2 ?? part.treatmentDm2 ?? 0;
        const materialCost = part.materialId === null && !qp.materialPricePerKg ? null : weight === null ? null : r2(weight * qp.materialPricePerKg);
        const treatmentsCost = r2(
          (qp.treatments ?? []).reduce((s, tr) => s + (tr.unit === 'DM2' ? dm2 : kg) * Number(tr.unitPrice ?? 0), 0),
        );
        const phasesCost = r2(
          (qp.phases ?? []).reduce((s, ph) => {
            const rate = Number(ph.machineHourlyRate ?? 0);
            return s + ((ph.programmingSeconds + ph.setupSeconds) * rate) / (3600 * q) + (ph.unitSeconds * rate) / 3600;
          }, 0),
        );
        const camCost = r2((qp.camSeconds * Number(qp.camPricePerMinute ?? 0)) / (60 * q));
        return {
          quotePartId: qp.id,
          quoteId: qp.quoteId,
          quoteNumber: qp.quote!.number,
          issueDate: qp.quote!.issueDate,
          customerName: qp.quote!.customer?.name ?? null,
          quantity: qp.quantity,
          productionQuantity: qp.productionQuantity,
          weightKg: weight,
          materialCost,
          treatmentsCost,
          phasesCost,
          camCost,
          totalCost: r2((materialCost ?? 0) + treatmentsCost + phasesCost + camCost),
        };
      })
      .sort((a, b) => String(b.issueDate).localeCompare(String(a.issueDate)) || b.quoteId - a.quoteId);
    return {
      part: {
        id: part.id,
        internalCode: part.internalCode,
        name: part.name,
        dimensions: part.dimensions,
        material: part.material?.name ?? null,
        supplier: part.supplier?.name ?? null,
      },
      items,
    };
  }
}
