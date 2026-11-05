import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { Content, CustomTableLayout, TableCell, TDocumentDefinitions } from 'pdfmake/interfaces';
import { SettingsService } from '../settings/settings.service';
import { PhaseDataService, PhaseRow } from './phase-data.service';
import { mm, renderPdf } from './pdf';
import { drawingLabel, fmtLocal, personName } from './report-utils';
import { addTimes, emptyTotals, formatHms, TimeTotals } from './time-calc';

export interface OrderTimesTotals extends TimeTotals {
  goodQty: number;
  scrapQty: number;
  /** Tempo totale (attrezzaggio + lavorazione netti) per tipologia macchina. */
  byMachineType: { name: string; seconds: number }[];
}

/** Righe orizzontali leggere con margini interni ridotti (la tabella fasi ha 17 colonne). */
const compactLayout: CustomTableLayout = {
  hLineWidth: (i, node) => (i === 0 || i === node.table.body.length ? 0 : i === 1 ? 1 : 0.5),
  vLineWidth: () => 0,
  hLineColor: (i) => (i === 1 ? '#333' : '#ccc'),
  paddingLeft: () => 2,
  paddingRight: () => 2,
  paddingTop: () => 2,
  paddingBottom: () => 2,
};

const PHASE_STATUS: Record<string, string> = { IN_PROGRESS: 'In corso', COMPLETED: 'Conclusa', SUSPENDED: 'Sospesa' };

/**
 * Stampa "tempi di produzione" di un ordine di produzione (03-report §1), con la regola unica dei
 * tempi netti: le colonne Tempo totale = attrezzaggio + lavorazione netti (coerenti tra loro).
 */
@Injectable()
export class ProductionOrderTimesService {
  constructor(
    private readonly ds: DataSource,
    private readonly phases: PhaseDataService,
    private readonly settings: SettingsService,
  ) {}

  async data(id: number) {
    const [order] = await this.ds.query(
      `SELECT po.id, po.status, po.quantity, po.expected_delivery_date::text AS expected_delivery_date, po.completed_at,
              d.code AS drawing_code, d.revision AS drawing_revision, c.name AS customer_name, co.code AS customer_order_code,
              (SELECT max(i.ended_at) FROM inspection i WHERE i.production_order_id = po.id AND i.deleted_at IS NULL) AS last_inspection_end
         FROM production_order po
         JOIN drawing d ON d.id = po.drawing_id
         JOIN customer_order co ON co.id = po.customer_order_id
         JOIN customer c ON c.id = co.customer_id
        WHERE po.id = $1 AND po.deleted_at IS NULL`,
      [id],
    );
    if (!order) throw new NotFoundException(`Ordine di produzione ${id} non trovato.`);

    const phases = await this.phases.load('wp.production_order_id = $1', [id], {
      orderBy: 'p.internal_code NULLS FIRST, wp.part_id NULLS FIRST, wp.phase_number, wp.setup_started_at, wp.id',
    });
    const inspections: any[] = await this.ds.query(
      `SELECT i.id, i.started_at, i.ended_at, i.good_qty, i.scrap_qty, i.notes, o.first_name, o.last_name
         FROM inspection i JOIN operator o ON o.id = i.operator_id
        WHERE i.production_order_id = $1 AND i.deleted_at IS NULL
        ORDER BY i.started_at, i.id`,
      [id],
    );

    const partKeys = [...new Set(phases.map((p) => p.partId ?? 0))];
    const byPart = partKeys.map((pid) => {
      const list = phases.filter((p) => (p.partId ?? 0) === pid);
      return { partId: pid || null, partCode: list[0]?.partCode ?? 'Senza particolare', totals: this.totals(list) };
    });
    // Data di completamento: quella dell'ordine, altrimenti la fine dell'ultimo collaudo.
    const completedAt = order.status === 'COMPLETED' ? (order.completed_at ?? order.last_inspection_end ?? null) : null;

    return {
      order: {
        id: order.id,
        status: order.status as string,
        quantity: order.quantity as number,
        expectedDeliveryDate: order.expected_delivery_date as string | null,
        completedAt: completedAt as Date | null,
        drawing: drawingLabel(order.drawing_code, order.drawing_revision),
        customerName: order.customer_name as string,
        customerOrderCode: order.customer_order_code as string,
      },
      phases,
      stops: phases.flatMap((p) => p.stops.map((s) => ({ ...s, phaseNumber: p.phaseNumber, partCode: p.partCode, operator: personName(p.operatorFirstName, p.operatorLastName) }))),
      inspections: inspections.map((i) => ({
        id: i.id as number,
        operator: personName(i.first_name, i.last_name),
        startedAt: i.started_at as Date,
        endedAt: i.ended_at as Date | null,
        goodQty: i.good_qty as number | null,
        scrapQty: i.scrap_qty as number | null,
        notes: i.notes as string | null,
        seconds: i.ended_at && new Date(i.ended_at) >= new Date(i.started_at) ? Math.round((new Date(i.ended_at).getTime() - new Date(i.started_at).getTime()) / 1000) : null,
      })),
      byPart,
      totals: this.totals(phases),
    };
  }

  /**
   * Totali di un gruppo di fasi.
   * Pezzi buoni: per ogni particolare quelli dell'ultima fase (numero fase più alto con pezzi
   * registrati), sommati tra i particolari; scarti: somma di tutte le fasi.
   */
  private totals(list: PhaseRow[]): OrderTimesTotals {
    const t = list.reduce((acc, p) => addTimes(acc, p.times), emptyTotals());
    const lastGood = new Map<number, { n: number; at: number; qty: number }>();
    const types = new Map<string, number>();
    let scrap = 0;
    for (const p of list) {
      scrap += p.scrapQty ?? 0;
      if (p.goodQty !== null && p.goodQty !== undefined) {
        const key = p.partId ?? 0;
        const at = new Date(p.setupStartedAt).getTime();
        const cur = lastGood.get(key);
        if (!cur || p.phaseNumber > cur.n || (p.phaseNumber === cur.n && at > cur.at)) lastGood.set(key, { n: p.phaseNumber, at, qty: p.goodQty });
      }
      types.set(p.machineTypeName, (types.get(p.machineTypeName) ?? 0) + p.times.total);
    }
    return {
      ...t,
      goodQty: [...lastGood.values()].reduce((s, v) => s + v.qty, 0),
      scrapQty: scrap,
      byMachineType: [...types.entries()].map(([name, seconds]) => ({ name, seconds })).sort((a, b) => b.seconds - a.seconds),
    };
  }

  async pdf(id: number): Promise<Buffer> {
    const d = await this.data(id);
    const company = await this.settings.get<string>('company_name', 'Milocco');
    const o = d.order;
    const stateText =
      o.status === 'COMPLETED' ? (o.completedAt ? `completato il ${fmtLocal(o.completedAt, 'dd/MM/yyyy')}` : 'completato') : o.status === 'IN_PROGRESS' ? 'in lavorazione' : 'da iniziare';

    const head = (labels: string[]): TableCell[] => labels.map((l) => ({ text: l, style: 'th' }));
    const dt = (v: Date | null | undefined) => (v ? fmtLocal(v, 'dd/MM/yy HH:mm') : '');
    const right = (text: string | number | null | undefined, extra: Record<string, unknown> = {}): TableCell => ({ text: text === null || text === undefined ? '' : String(text), alignment: 'right', ...extra });
    const dur = (s: number | null | undefined, open = false) => right(open && !s ? 'in corso' : formatHms(s ?? 0));

    const phaseRows: TableCell[][] = d.phases.map((p) => {
      const lastReason = [...p.stops].reverse().find((s) => s.reasonName)?.reasonName;
      const state = p.status === 'SUSPENDED' && lastReason ? `Sospesa (${lastReason})` : PHASE_STATUS[p.status] ?? p.status;
      return [
        right(p.phaseNumber),
        personName(p.operatorFirstName, p.operatorLastName),
        p.machineName,
        p.partCode ?? '',
        { text: p.times.invalid ? `${state} · orari incoerenti` : state },
        right(p.goodQty ?? ''),
        right(p.scrapQty ?? ''),
        dt(p.setupStartedAt),
        dt(p.setupEndedAt),
        dur(p.times.setupNet, !p.setupEndedAt),
        right(p.setupEndedAt && p.workStartedAt ? formatHms(p.times.intermediate) : ''),
        dt(p.workStartedAt),
        dt(p.workEndedAt),
        dur(p.times.workNet, !!p.workStartedAt && !p.workEndedAt),
        right(p.times.avgUnitSeconds !== null ? formatHms(p.times.avgUnitSeconds) : ''),
        right(formatHms(p.times.total)),
        right(p.stops.length || ''),
      ];
    });

    const totalsTable = (t: OrderTimesTotals): Content => ({
      table: {
        headerRows: 1,
        widths: Array(11).fill('*'),
        body: [
          head(['Pezzi buoni', 'Pezzi scartati', 'Fermo macchina', 'Pause operatore', 'Attrezzaggio', 'Intermedio', 'Lavorazione', 'Tempo ordine\n(attr. + lav.)', 'Tempo complessivo\n(attr. + interm. + lav.)', 'Fasi', 'Per tipologia macchina']).map(
            (c, i) => (i < 10 ? { ...(c as object), alignment: 'right' } : c) as TableCell,
          ),
          [
            right(t.goodQty), right(t.scrapQty), right(formatHms(t.machineStopSeconds)), right(formatHms(t.pauseSeconds)),
            right(formatHms(t.setupNet)), right(formatHms(t.intermediate)), right(formatHms(t.workNet)),
            right(formatHms(t.total), { bold: true }), right(formatHms(t.overall)), right(t.phases),
            { text: t.byMachineType.map((b) => `${b.name}: ${formatHms(b.seconds)}`).join('\n'), fontSize: 7 },
          ],
        ],
      },
      layout: 'lightHorizontalLines',
      margin: [0, 2, 0, 8],
    });

    const content: Content[] = [
      { text: `Fasi di lavorazione per l'ordine ${o.id} - ${stateText}`, style: 'title' },
      {
        text: [
          { text: `Disegno ${o.drawing} - ${o.customerName}`, bold: true },
          { text: `   Ordine cliente ${o.customerOrderCode} · Quantità ${o.quantity}${o.expectedDeliveryDate ? ` · Consegna prevista ${fmtLocal(`${o.expectedDeliveryDate}T12:00:00Z`, 'dd/MM/yyyy')}` : ''}`, color: '#555' },
        ],
        fontSize: 12,
        margin: [0, 2, 0, 8],
      },
      d.phases.length === 0
        ? { text: 'Non ci sono fasi registrate per quest\'ordine.', italics: true, margin: [0, 0, 0, 8] }
        : {
            table: {
              headerRows: 1,
              dontBreakRows: true,
              // Larghezze in mm: totale 260 + margini interni delle celle = larghezza utile A4 orizzontale.
              widths: [8, 20, 16, 24, 18, 10, 10, 18, 18, 15, 14, 18, 18, 15, 14, 15, 9].map((w) => mm(w)),
              body: [
                head(['Fase #', 'Operatore', 'Macchina', 'Particolare', 'Stato', 'Pezzi buoni', 'Pezzi scartati', 'Inizio attrezzaggio', 'Fine attrezzaggio', 'Tempo attrezzaggio', 'Tempo intermedio', 'Inizio lavorazione', 'Fine lavorazione', 'Tempo lavorazione', 'Tempo medio unitario', 'Tempo totale', '# Fermi']),
                ...phaseRows,
              ],
            },
            layout: compactLayout,
            fontSize: 7,
            margin: [0, 0, 0, 10],
          },
      { text: `Fermi macchina per l'ordine ${o.id}`, style: 'h2' },
      d.stops.length === 0
        ? { text: "Non ci sono fermi macchina registrati per quest'ordine.", italics: true, margin: [0, 0, 0, 8] }
        : {
            table: {
              headerRows: 1,
              widths: [mm(22), mm(25), '*', '*', mm(32), mm(32), mm(25), mm(25)],
              body: [
                head(['Numero fase', 'Particolare', 'Operatore', 'Causale', 'Inizio', 'Fine', 'Tempo', 'Macchina ferma']),
                ...d.stops.map((s): TableCell[] => [
                  right(s.phaseNumber), s.partCode ?? '', s.operator, s.reasonName ?? 'Non dichiarata', dt(s.startedAt), s.endedAt ? dt(s.endedAt) : 'non chiuso',
                  right(s.endedAt && s.endedAt >= s.startedAt ? formatHms((new Date(s.endedAt).getTime() - new Date(s.startedAt).getTime()) / 1000) : ''),
                  s.machineStopped ? 'Sì' : 'No (pausa operatore)',
                ]),
              ],
            },
            layout: 'lightHorizontalLines',
            fontSize: 8,
            margin: [0, 0, 0, 10],
          },
      { text: `Collaudi per l'ordine ${o.id}`, style: 'h2' },
      d.inspections.length === 0
        ? { text: "Non ci sono collaudi registrati per quest'ordine.", italics: true, margin: [0, 0, 0, 8] }
        : {
            table: {
              headerRows: 1,
              widths: [mm(18), mm(35), mm(20), mm(20), mm(30), mm(30), mm(25), '*'],
              body: [
                head(['Collaudo', 'Operatore', 'Pezzi buoni', 'Pezzi scarti', 'Inizio collaudo', 'Fine collaudo', 'Tempo collaudo', 'Note']),
                ...d.inspections.map((i, idx): TableCell[] => [
                  right(idx + 1), i.operator, right(i.goodQty ?? ''), right(i.scrapQty ?? ''), dt(i.startedAt), i.endedAt ? dt(i.endedAt) : 'in corso',
                  right(i.seconds !== null ? formatHms(i.seconds) : ''), i.notes ?? '',
                ]),
              ],
            },
            layout: 'lightHorizontalLines',
            fontSize: 8,
            margin: [0, 0, 0, 10],
          },
    ];

    if (d.byPart.length > 1) {
      for (const part of d.byPart) {
        content.push({ stack: [{ text: `Totali per l'ordine ${o.id}, particolare ${part.partCode}`, style: 'h2' }, totalsTable(part.totals)], unbreakable: true });
      }
    }
    content.push({ stack: [{ text: `Totali per l'ordine ${o.id}`, style: 'h2' }, totalsTable(d.totals)], unbreakable: true });
    content.push({
      text: 'Tempi netti: dall\'attrezzaggio si tolgono i fermi che vi ricadono; dalla lavorazione solo i fermi con macchina ferma. I collaudi non entrano nei totali. Le fasi non chiuse non contano nei totali.',
      fontSize: 7,
      color: '#666',
      margin: [0, 6, 0, 0],
    });

    const printedAt = fmtLocal(new Date(), 'dd/MM/yyyy HH:mm');
    const def: TDocumentDefinitions = {
      pageSize: 'A4',
      pageOrientation: 'landscape',
      pageMargins: [mm(5), mm(16), mm(5), mm(12)],
      info: { title: `Tempi ordine ${o.id}`, author: company },
      defaultStyle: { font: 'Roboto', fontSize: 8 },
      styles: {
        title: { fontSize: 16, bold: true },
        h2: { fontSize: 11, bold: true, margin: [0, 6, 0, 3] },
        th: { bold: true, fontSize: 7, color: '#222', fillColor: '#eef1f5' },
      },
      header: () => ({
        columns: [
          { text: company, bold: true, fontSize: 11 },
          { text: `Tempi di produzione · ordine ${o.id}`, alignment: 'right', fontSize: 9, color: '#555' },
        ],
        margin: [mm(5), mm(6), mm(5), 0],
      }),
      footer: (page: number, pages: number) => ({
        columns: [
          { text: `Stampato il ${printedAt}`, fontSize: 7, color: '#777' },
          { text: `Pagina ${page} di ${pages}`, alignment: 'right', fontSize: 7, color: '#777' },
        ],
        margin: [mm(5), mm(4), mm(5), 0],
      }),
      content,
    };
    return renderPdf(def);
  }
}
