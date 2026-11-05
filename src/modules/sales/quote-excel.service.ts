import { BadRequestException, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { unlinkSync, writeFileSync } from 'fs';
import { extname, resolve } from 'path';
import { DataSource, EntityManager } from 'typeorm';
import * as ExcelJS from 'exceljs';
import { BAR_SHAPES } from '../../shared';
import { writeAudit } from '../../common/crud/crud.service';
import { Drawing, DrawingPart, FileAttachment, MachineType, Part, Quote } from '../../entities';
import { FilesService } from '../support/files.service';
import {
  C, cellNumber, cellText, EXCEL_SLOTS, ExcelSlot, ExcelSlotKey, exportNames, FIRST_DATA_ROW, LEGEND_TEXT, MARKUP_CELL,
  MATERIAL_MARKUP_CELL, parseTitle, resolveSlots, T, TITLE_CELL,
} from './quote-excel-layout';
import { partInternalCode, revisionFromDescription, splitExcelCode, DEFAULT_REVISION } from './part-code';
import { QuotesService } from './quotes.service';

export interface ImportPhasePlan {
  slot: ExcelSlotKey;
  slotLabel: string;
  machineTypeId: number | null;
  machineTypeName: string | null;
  machineId: number | null;
  machineName: string | null;
  programmingSeconds: number;
  setupSeconds: number;
  unitSeconds: number;
}

export interface ImportRowPlan {
  row: number;
  code: string;
  description: string;
  quantity: number | null;
  productionQuantity: number | null;
  camSeconds: number;
  notes: string | null;
  /** Particolare esistente trovato. */
  partId: number | null;
  partCode: string | null;
  /** Particolare (e disegno) da creare. */
  newPart: { drawingCode: string; revision: string; internalCode: string; name: string; materialId: number | null; materialName: string | null } | null;
  phases: ImportPhasePlan[];
  errors: string[];
  warnings: string[];
}

export interface ImportReport {
  /** true se il file non ha errori (in anteprima: si può importare). */
  ok: boolean;
  /** true se il preventivo è stato creato. */
  saved: boolean;
  quoteId: number | null;
  fileName: string;
  header: {
    customerText: string; customerId: number | null; customerName: string | null; number: string; expectedDeliveryDate: string | null;
    materialMarkup: number | null; markup: number | null;
  };
  rows: ImportRowPlan[];
  errors: string[];
  warnings: string[];
}

const MIME_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Export e import del preventivo in Excel (01-commerciale §1.6–1.7, con le correzioni decise). */
@Injectable()
export class QuoteExcelService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly quotes: QuotesService,
    private readonly files: FilesService,
  ) {}

  // ================================================================== EXPORT

  async export(id: number): Promise<{ fileName: string; buffer: Buffer }> {
    const { quote, parts, costs } = await this.quotes.exportData(id);
    const types = await this.dataSource.getRepository(MachineType).find({ withDeleted: true });
    const slots = resolveSlots(types);
    const customerName = quote.customer?.name ?? '';
    const names = exportNames(quote.number, customerName);
    const cons = quote.expectedDeliveryDate ? quote.expectedDeliveryDate.split('-').reverse().join('/') : '';
    const titleBase = `${customerName} - ORDINE ${quote.number} - Cons. ${cons}`;

    const wb = new ExcelJS.Workbook();
    wb.creator = 'Milocco gestionale';
    wb.created = new Date();
    const wt = wb.addWorksheet(names.timesSheet, { pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 } });
    const wc = wb.addWorksheet(names.costsSheet, { pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 } });

    // ---- intestazioni comuni (B–G)
    const common: [string, string, number][] = [['B', 'Pos.', 5], ['C', 'Codice', 16], ['D', 'Descrizione', 30], ['E', 'Um', 5], ['F', 'Q.tà ord.', 8], ['G', 'Q.tà prod.', 8]];
    for (const ws of [wt, wc]) {
      ws.getColumn('A').width = 2;
      for (const [col, label, width] of common) this.header(ws, col, label, width);
    }

    // ---- foglio Tempi
    wt.getCell(TITLE_CELL).value = `${titleBase} - Riepilogo Tempi`;
    this.header(wt, T.shape, 'Tipo', 10);
    this.header(wt, T.material, 'Materiale', 14);
    this.header(wt, T.dimensions, 'Misure grezzo', 16);
    this.header(wt, T.supplier, 'Fornitore', 14);
    this.header(wt, T.treatments, 'Trattamenti', 18);
    this.header(wt, T.cam, 'Prg CAM', 8, 'min');
    for (const s of EXCEL_SLOTS) this.slotHeader(wt, s, s.timeCols, 'min');
    this.header(wt, T.notes, 'NOTE', 22);
    this.header(wt, T.weight, 'Kg', 8, 'kg');
    this.header(wt, T.pricePerKg, '€/kg', 8, '€/kg');
    this.header(wt, T.materialCost, '€/pz', 9, 'materiale');
    this.header(wt, T.treatmentsCost, '€/pz (Trattamenti)', 11, 'trattamenti');
    this.header(wt, T.otherTimes, 'Altre lav.', 9, 'min');

    // ---- foglio Costi
    wc.getCell(TITLE_CELL).value = `${titleBase} - Riepilogo Costi`;
    this.header(wc, C.treatments, 'Trattamento', 18);
    this.header(wc, C.treatmentsCost, '€ Trat', 9, '€/pz');
    this.header(wc, C.materialCost, '€ mat.', 9, '€/pz');
    this.header(wc, C.cam, 'Prg CAM', 9, '€/pz');
    for (const s of EXCEL_SLOTS) this.slotHeader(wc, s, s.costCols, '€/pz');
    this.header(wc, C.notes, 'NOTE', 22, 'Ricarichi →');
    this.header(wc, C.materialWithMarkup, 'Ricarico materiale', 11);
    this.header(wc, C.workTotal, '€ totale lavoro unit.', 11, '€/pz');
    this.header(wc, C.unitPrice, '€ pezzo con ricarico', 11);
    this.header(wc, C.linePrice, '€ totale riga', 12, '€');
    this.header(wc, C.otherCosts, 'Altre lav.', 9, '€/pz');
    const mm = wc.getCell(MATERIAL_MARKUP_CELL);
    mm.value = quote.materialMarkup;
    mm.numFmt = '0.00#';
    mm.font = { bold: true, color: { argb: 'FF1D4ED8' } };
    const mk = wc.getCell(MARKUP_CELL);
    mk.value = quote.markup;
    mk.numFmt = '0.00#';
    mk.font = { bold: true, color: { argb: 'FF1D4ED8' } };

    // ---- righe
    const minutes = (s: number) => (s ? Math.round((s / 60) * 100) / 100 : null);
    const money = (v: number) => (v ? v : null);
    let r = FIRST_DATA_ROW;
    parts.forEach((p, i) => {
      const c = costs.parts[i].cost;
      const part = p.part;
      const times: Record<string, number> = {};
      const money3: Record<string, number> = {};
      let otherSeconds = 0;
      let otherCost = 0;
      for (const f of c.phases) {
        const key = slots.get(f.machineTypeId);
        const slot = EXCEL_SLOTS.find((s) => s.key === key);
        if (!slot) {
          otherSeconds += f.unitSeconds;
          otherCost += f.cost;
          continue;
        }
        if (slot.full) {
          const add = (col: string, v: number) => (times[col] = (times[col] ?? 0) + v);
          add(slot.timeCols[0], f.programmingSeconds);
          add(slot.timeCols[1], f.setupSeconds);
          add(slot.timeCols[2], f.unitSeconds);
          const addC = (col: string, v: number) => (money3[col] = (money3[col] ?? 0) + v);
          addC(slot.costCols[0], f.programmingCost);
          addC(slot.costCols[1], f.setupCost);
          addC(slot.costCols[2], f.workCost);
        } else {
          times[slot.timeCols[0]] = (times[slot.timeCols[0]] ?? 0) + f.unitSeconds;
          money3[slot.costCols[0]] = (money3[slot.costCols[0]] ?? 0) + f.cost;
        }
      }
      const treatmentNames = (p.treatments ?? []).map((t) => t.treatment?.name ?? `#${t.treatmentId}`).join(' - ');
      const shape = part?.barType?.shape ? BAR_SHAPES[part.barType.shape] ?? part.barType.shape : null;

      for (const ws of [wt, wc]) {
        ws.getCell(`B${r}`).value = i + 1;
        ws.getCell(`C${r}`).value = part?.internalCode ?? '';
        ws.getCell(`D${r}`).value = part?.name ?? '';
        ws.getCell(`E${r}`).value = 'Pz';
        ws.getCell(`F${r}`).value = p.quantity;
        ws.getCell(`G${r}`).value = p.productionQuantity;
      }
      wt.getCell(`${T.shape}${r}`).value = shape;
      wt.getCell(`${T.material}${r}`).value = part?.material?.name ?? null;
      wt.getCell(`${T.dimensions}${r}`).value = part?.dimensions ?? null;
      wt.getCell(`${T.supplier}${r}`).value = part?.supplier?.name ?? null;
      wt.getCell(`${T.treatments}${r}`).value = treatmentNames || null;
      wt.getCell(`${T.cam}${r}`).value = minutes(p.camSeconds);
      for (const s of EXCEL_SLOTS) for (const col of s.timeCols) wt.getCell(`${col}${r}`).value = minutes(times[col] ?? 0);
      wt.getCell(`${T.notes}${r}`).value = p.notes;
      wt.getCell(`${T.weight}${r}`).value = p.weightKg;
      wt.getCell(`${T.pricePerKg}${r}`).value = money(p.materialPricePerKg);
      wt.getCell(`${T.materialCost}${r}`).value = money(c.materialCost);
      wt.getCell(`${T.treatmentsCost}${r}`).value = money(c.treatmentsCost);
      wt.getCell(`${T.otherTimes}${r}`).value = minutes(otherSeconds);

      wc.getCell(`${C.treatments}${r}`).value = treatmentNames || null;
      wc.getCell(`${C.treatmentsCost}${r}`).value = money(c.treatmentsCost);
      wc.getCell(`${C.materialCost}${r}`).value = money(c.materialCost);
      wc.getCell(`${C.cam}${r}`).value = money(c.camCost);
      for (const s of EXCEL_SLOTS) for (const col of s.costCols) wc.getCell(`${col}${r}`).value = money(Math.round((money3[col] ?? 0) * 100) / 100);
      wc.getCell(`${C.notes}${r}`).value = p.notes;
      wc.getCell(`${C.otherCosts}${r}`).value = money(Math.round(otherCost * 100) / 100);
      const matWithMarkup = c.materialCost * quote.materialMarkup;
      const work = c.treatmentsCost + c.camCost + c.phasesCost;
      const unitPrice = (matWithMarkup + work) * quote.markup;
      wc.getCell(`${C.materialWithMarkup}${r}`).value = { formula: `${C.materialCost}${r}*$AA$5`, result: matWithMarkup };
      wc.getCell(`${C.workTotal}${r}`).value = { formula: `${C.treatmentsCost}${r}+SUM(K${r}:Y${r})+${C.otherCosts}${r}`, result: work };
      wc.getCell(`${C.unitPrice}${r}`).value = { formula: `(${C.materialWithMarkup}${r}+${C.workTotal}${r})*$AC$5`, result: unitPrice };
      wc.getCell(`${C.linePrice}${r}`).value = { formula: `${C.unitPrice}${r}*G${r}`, result: unitPrice * p.productionQuantity };
      r++;
    });
    const lastData = r - 1;

    // ---- formati e bordi delle righe dati
    const timeCols = [T.cam, ...EXCEL_SLOTS.flatMap((s) => s.timeCols), T.otherTimes];
    const tMoney = [T.pricePerKg, T.materialCost, T.treatmentsCost];
    const cMoney = [C.treatmentsCost, C.materialCost, C.cam, ...EXCEL_SLOTS.flatMap((s) => s.costCols), C.otherCosts, C.materialWithMarkup, C.workTotal, C.unitPrice, C.linePrice];
    this.formatData(wt, FIRST_DATA_ROW, lastData, 'AG', { numeric: timeCols, money: tMoney, weight: [T.weight] });
    this.formatData(wc, FIRST_DATA_ROW, lastData, 'AE', { numeric: [], money: cMoney, weight: [] });
    for (let i = FIRST_DATA_ROW; i <= lastData; i++) {
      wc.getCell(`${C.unitPrice}${i}`).font = { bold: true };
      wc.getCell(`${C.linePrice}${i}`).font = { bold: true };
    }

    // ---- totale (foglio Costi) e legenda (foglio Tempi: 2 righe vuote + legenda, come il modello)
    const totalRow = lastData + 2;
    wc.getCell(`${C.unitPrice}${totalRow}`).value = 'Totale';
    wc.getCell(`${C.unitPrice}${totalRow}`).font = { bold: true };
    wc.getCell(`${C.unitPrice}${totalRow}`).alignment = { horizontal: 'right' };
    const tot = wc.getCell(`${C.linePrice}${totalRow}`);
    tot.value = { formula: lastData >= FIRST_DATA_ROW ? `SUM(${C.linePrice}${FIRST_DATA_ROW}:${C.linePrice}${lastData})` : '0', result: costs.totals.totalPrice };
    tot.numFmt = '#,##0.00 "€"';
    tot.font = { bold: true };
    tot.border = { top: { style: 'medium' } };
    wt.getCell(`B${lastData + 3}`).value = LEGEND_TEXT;
    wt.getCell(`B${lastData + 3}`).font = { italic: true, size: 9, color: { argb: 'FF6B7280' } };

    for (const ws of [wt, wc]) {
      const title = ws.getCell(TITLE_CELL);
      title.font = { bold: true, size: 14 };
      ws.getRow(2).height = 24;
      ws.getRow(3).height = 30;
      ws.views = [{ state: 'frozen', xSplit: 4, ySplit: 5 }];
    }

    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    return { fileName: names.fileName, buffer };
  }

  private headerStyle(cell: ExcelJS.Cell) {
    cell.font = { bold: true, size: 10 };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } };
    cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
  }

  /** Intestazione su una colonna: righe 3–4 unite, riga 5 = unità di misura. */
  private header(ws: ExcelJS.Worksheet, col: string, label: string, width?: number, unit?: string) {
    ws.mergeCells(`${col}3:${col}4`);
    ws.getCell(`${col}3`).value = label;
    this.headerStyle(ws.getCell(`${col}3`));
    const u = ws.getCell(`${col}5`);
    if (unit && !(ws.name.endsWith('_Costi') && (`${col}5` === MATERIAL_MARKUP_CELL || `${col}5` === MARKUP_CELL))) u.value = unit;
    u.font = { italic: true, size: 9, color: { argb: 'FF6B7280' } };
    u.alignment = { horizontal: 'center' };
    u.border = { bottom: { style: 'thin' } };
    if (width) ws.getColumn(col).width = width;
  }

  /** Intestazione di una tipologia: nome su riga 3 (unito sulle sue colonne), Prg./Attr./Lavor. su riga 4. */
  private slotHeader(ws: ExcelJS.Worksheet, s: ExcelSlot, cols: string[], unit: string) {
    if (cols.length > 1) ws.mergeCells(`${cols[0]}3:${cols[cols.length - 1]}3`);
    ws.getCell(`${cols[0]}3`).value = s.label;
    this.headerStyle(ws.getCell(`${cols[0]}3`));
    const subs = cols.length > 1 ? ['Prg.', 'Attr.', 'Lavor.'] : ['Lavor.'];
    cols.forEach((col, i) => {
      const c = ws.getCell(`${col}4`);
      c.value = subs[i];
      this.headerStyle(c);
      const u = ws.getCell(`${col}5`);
      u.value = unit;
      u.font = { italic: true, size: 9, color: { argb: 'FF6B7280' } };
      u.alignment = { horizontal: 'center' };
      u.border = { bottom: { style: 'thin' } };
      ws.getColumn(col).width = 8;
    });
  }

  private formatData(ws: ExcelJS.Worksheet, from: number, to: number, lastCol: string, f: { numeric: string[]; money: string[]; weight: string[] }) {
    const last = ws.getColumn(lastCol).number;
    for (let r = from; r <= to; r++) {
      const row = ws.getRow(r);
      for (let c = 2; c <= last; c++) {
        const cell = row.getCell(c);
        cell.border = { top: { style: 'hair' }, left: { style: 'thin' }, bottom: { style: 'hair' }, right: { style: 'thin' } };
        cell.alignment = { vertical: 'top', wrapText: c === 4 };
        if (r % 2 === 1) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF9FAFB' } };
      }
      for (const col of f.numeric) row.getCell(col).numFmt = 'General';
      for (const col of f.money) row.getCell(col).numFmt = '#,##0.00 "€"';
      for (const col of f.weight) row.getCell(col).numFmt = '0.000';
    }
  }

  // ================================================================== IMPORT

  /**
   * Import di un preventivo da Excel. Con dryRun restituisce solo l'anteprima con errori e avvisi per riga.
   * Senza errori (e senza dryRun) crea preventivo, eventuali disegni/particolari nuovi, righe e fasi
   * in un'unica transazione e salva il file caricato.
   */
  async import(file: Express.Multer.File | undefined, opts: { dryRun: boolean; userId?: number }): Promise<ImportReport> {
    if (!file?.buffer?.length) throw new BadRequestException('Carica un file Excel (.xlsx).');
    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(file.buffer as unknown as ArrayBuffer);
    } catch {
      throw new BadRequestException(`Il file "${file.originalname}" non è un Excel .xlsx leggibile.`);
    }
    const report = await this.plan(wb, file.originalname);
    if (!report.ok || opts.dryRun) return report;

    const storedName = `${randomUUID()}${extname(file.originalname) || '.xlsx'}`;
    const path = resolve(this.files.dir, storedName);
    writeFileSync(path, file.buffer);
    try {
      report.quoteId = await this.dataSource.transaction((em) => this.save(em, report, { file, storedName, userId: opts.userId }));
      report.saved = true;
      return report;
    } catch (err) {
      try { unlinkSync(path); } catch { /* il file potrebbe non esistere */ }
      throw err;
    }
  }

  /** Legge e valida il file senza scrivere nulla. */
  private async plan(wb: ExcelJS.Workbook, fileName: string): Promise<ImportReport> {
    const em = this.dataSource.manager;
    const report: ImportReport = {
      ok: false, saved: false, quoteId: null, fileName,
      header: { customerText: '', customerId: null, customerName: null, number: '', expectedDeliveryDate: null, materialMarkup: null, markup: null },
      rows: [], errors: [], warnings: [],
    };
    const [wt, wc] = wb.worksheets;
    if (!wt || !wc) {
      report.errors.push('Il file deve avere due fogli: il primo con i tempi, il secondo con i costi.');
      return report;
    }
    if (wt.rowCount < 5) {
      report.errors.push('Il foglio dei tempi è vuoto o incompleto (servono le righe di intestazione 1–5).');
      return report;
    }

    // ---- testata
    const title = parseTitle(cellText(wt.getCell(TITLE_CELL).value));
    report.errors.push(...title.errors);
    report.header.customerText = title.customer;
    report.header.number = title.number;
    report.header.expectedDeliveryDate = title.delivery;
    if (title.customer) {
      const c = await this.findCustomer(em, title.customer);
      if ('error' in c) report.errors.push(c.error);
      else Object.assign(report.header, { customerId: c.id, customerName: c.name });
    }
    if (title.number) {
      try {
        await this.quotes.assertNumberFree(em, title.number);
      } catch {
        report.errors.push(`Il preventivo numero "${title.number}" è già presente: eliminalo o cambia il numero nel titolo (B2).`);
      }
    }
    const d = await this.quotes.defaults();
    const factor = (cell: string, label: string, def: number) => {
      const v = cellNumber(wc.getCell(cell).value);
      if (v === null || v <= 0) {
        report.warnings.push(`${label} non trovato in ${cell} del foglio costi: uso il valore predefinito ${def}.`);
        return def;
      }
      return v;
    };
    report.header.materialMarkup = factor(MATERIAL_MARKUP_CELL, 'Ricarico materiale', d.materialMarkup);
    report.header.markup = factor(MARKUP_CELL, 'Ricarico finale', d.markup);

    // ---- tipologie per colonna
    const types = await em.getRepository(MachineType).find({ order: { sortOrder: 'ASC', name: 'ASC', id: 'ASC' } });
    const slotOf = resolveSlots(types);
    const typesBySlot = new Map<ExcelSlotKey, MachineType[]>();
    for (const t of types) {
      const k = slotOf.get(t.id);
      if (k) typesBySlot.set(k, [...(typesBySlot.get(k) ?? []), t]);
    }
    const machinesByType = await this.quotes.machinesByType(em, types.map((t) => t.id));
    const plannedNew = new Map<string, ImportRowPlan['newPart']>();

    // ---- righe
    const last = wt.rowCount;
    for (let r = FIRST_DATA_ROW; r <= last; r++) {
      const get = (col: string) => wt.getCell(`${col}${r}`).value;
      const posText = cellText(get('B'));
      if (posText.startsWith('Ӿ') || /troncatrice|legenda/i.test(posText)) break;
      const code = cellText(get(T.code));
      const description = cellText(get(T.description));
      const slotCells = EXCEL_SLOTS.flatMap((s) => s.timeCols);
      const anyValue = [T.code, T.description, T.quantity, T.productionQuantity, T.cam, T.notes, ...slotCells].some((col) => cellText(get(col)) !== '');
      if (!anyValue) continue;

      const row: ImportRowPlan = {
        row: r, code, description, quantity: null, productionQuantity: null, camSeconds: 0, notes: cellText(get(T.notes)) || null,
        partId: null, partCode: null, newPart: null, phases: [], errors: [], warnings: [],
      };
      report.rows.push(row);
      if (!code) row.errors.push('Codice del particolare vuoto (colonna C).');

      const int = (col: string, label: string, required: boolean) => {
        const raw = get(col);
        const v = cellNumber(raw);
        if (v === null) {
          if (cellText(raw) !== '') row.errors.push(`${label} non numerica (colonna ${col}).`);
          else if (required) row.errors.push(`${label} mancante (colonna ${col}).`);
          return null;
        }
        if (v < 0) { row.errors.push(`${label} negativa (colonna ${col}).`); return null; }
        if (!Number.isInteger(v)) row.warnings.push(`${label} ${v} arrotondata a ${Math.round(v)}.`);
        return Math.round(v);
      };
      row.quantity = int(T.quantity, 'Quantità ordinata', true);
      row.productionQuantity = int(T.productionQuantity, 'Quantità da produrre', false);
      if (row.productionQuantity === null && row.quantity !== null && cellText(get(T.productionQuantity)) === '') {
        row.productionQuantity = row.quantity;
        row.warnings.push('Quantità da produrre non indicata: uguale alla quantità ordinata.');
      }
      if (row.productionQuantity === 0) row.warnings.push('Quantità da produrre 0: i tempi fissi non entrano nei costi.');
      const minutes = (col: string) => {
        const raw = get(col);
        const v = cellNumber(raw);
        if (v === null) {
          if (cellText(raw) !== '') row.errors.push(`Valore non numerico in colonna ${col}: "${cellText(raw)}".`);
          return 0;
        }
        if (v < 0) { row.errors.push(`Tempo negativo in colonna ${col}.`); return 0; }
        return Math.round(v * 60);
      };
      row.camSeconds = minutes(T.cam);
      const other = cellNumber(get(T.otherTimes));
      if (other) row.warnings.push(`I tempi della colonna "Altre lav." (${T.otherTimes}) non vengono importati: aggiungi le fasi a mano.`);

      // ---- particolare
      if (code) await this.resolvePart(em, row, plannedNew, cellText(get(T.material)));

      // ---- fasi
      const cycleTypes = row.partId
        ? ((await em.query('SELECT DISTINCT machine_type_id FROM part_cycle_step WHERE part_id = $1', [row.partId])) as { machine_type_id: number }[]).map((x) => Number(x.machine_type_id))
        : [];
      for (const s of EXCEL_SLOTS) {
        const vals = s.timeCols.map((col) => minutes(col));
        if (!vals.some((v) => v > 0)) continue;
        const [prg, attr, lav] = s.full ? vals : [0, 0, vals[0]];
        const candidates = typesBySlot.get(s.key) ?? [];
        const type = candidates.find((t) => cycleTypes.includes(t.id)) ?? candidates[0];
        const phase: ImportPhasePlan = {
          slot: s.key, slotLabel: s.label, machineTypeId: type?.id ?? null, machineTypeName: type?.name ?? null, machineId: null, machineName: null,
          programmingSeconds: prg, setupSeconds: attr, unitSeconds: lav,
        };
        row.phases.push(phase);
        if (!type) {
          row.errors.push(`Nessuna tipologia macchina collegata alla colonna "${s.label}": impostala in Anagrafiche › Tipologie macchina (colonna Excel).`);
          continue;
        }
        const fromQuote = row.partId ? (await this.quotes.lastQuoteMachines(em, row.partId, [type.id])).get(type.id) : undefined;
        const m = fromQuote ?? machinesByType.get(type.id)?.[0];
        if (!m) row.errors.push(`Nessuna macchina della tipologia "${type.name}".`);
        else Object.assign(phase, { machineId: m.id, machineName: m.name });
      }
      if (!row.phases.length && !row.camSeconds) row.warnings.push('Nessun tempo indicato per questo particolare.');

      // ---- avvisi sui prezzi (come nelle proposte)
      if (row.partId) {
        const tr = await this.quotes.drawingTreatments(em, row.partId);
        for (const t of tr) if (t.unitPrice === null) row.warnings.push(`Trattamento "${t.name}" senza prezzo in anagrafica: inserito a 0.`);
        const p = await em.getRepository(Part).findOne({ where: { id: row.partId }, relations: { material: true } });
        if (p && !p.material?.pricePerKg) row.warnings.push('Materiale assente o senza prezzo €/kg: costo materiale 0.');
        if (p && p.weightKg === null) row.warnings.push('Peso del particolare non indicato: costo materiale 0.');
      } else if (row.newPart) {
        row.warnings.push(`Particolare nuovo ${row.newPart.internalCode}: verrà creato con il disegno ${row.newPart.drawingCode} rev. ${row.newPart.revision} (da completare).`);
      }
    }
    if (!report.rows.length) report.errors.push('Nessuna riga di particolari trovata dalla riga 6 del foglio dei tempi.');
    report.ok = report.errors.length === 0 && report.rows.every((r) => r.errors.length === 0);
    return report;
  }

  private async findCustomer(em: EntityManager, text: string): Promise<{ id: number; name: string } | { error: string }> {
    const exact: { id: number; name: string }[] = await em.query(
      'SELECT id, name FROM customer WHERE deleted_at IS NULL AND lower(trim(name)) = lower(trim($1)) ORDER BY id LIMIT 1',
      [text],
    );
    if (exact.length) return { id: Number(exact[0].id), name: exact[0].name };
    const like: { id: number; name: string }[] = await em.query(
      "SELECT id, name FROM customer WHERE deleted_at IS NULL AND left(lower(name), length($1)) = lower($1) ORDER BY name LIMIT 6",
      [text.trim()],
    );
    if (like.length === 1) return { id: Number(like[0].id), name: like[0].name };
    if (like.length > 1) {
      return { error: `Il cliente "${text}" corrisponde a più clienti (${like.slice(0, 5).map((c) => c.name).join(', ')}): scrivi il nome completo nel titolo (B2).` };
    }
    return { error: `Il cliente "${text}" non esiste in anagrafica: crealo oppure correggi il nome nel titolo (B2).` };
  }

  /**
   * Trova il particolare della riga:
   * 1) codice interno uguale alla colonna C (anche "CODICE.REV" scritto dall'export);
   * 2) con revisione esplicita (nel codice o "Rev.XX"/"RXX" in fondo alla descrizione): codice interno "<codice>.<rev>";
   * 3) senza revisione: il particolare più recente con codice interno "<codice>.<qualsiasi revisione>";
   * 4) disegno con stesso codice e revisione: il suo primo particolare;
   * altrimenti si crea disegno + particolare (revisione 00 se non indicata).
   */
  private async resolvePart(em: EntityManager, row: ImportRowPlan, plannedNew: Map<string, ImportRowPlan['newPart']>, materialText: string) {
    const findPart = async (sql: string, params: unknown[]) => {
      const rows: { id: number; internal_code: string }[] = await em.query(sql, params);
      return rows[0] ? { id: Number(rows[0].id), internalCode: rows[0].internal_code } : null;
    };
    const exact = await findPart('SELECT id, internal_code FROM part WHERE deleted_at IS NULL AND lower(internal_code) = lower($1) ORDER BY created_at DESC, id DESC LIMIT 1', [row.code]);
    if (exact) return Object.assign(row, { partId: exact.id, partCode: exact.internalCode });

    const fromCode = splitExcelCode(row.code);
    const fromDescr = revisionFromDescription(row.description);
    const base = fromCode.revision ? fromCode.code : row.code;
    const revision = fromCode.revision ?? fromDescr.revision;
    let found = revision
      ? await findPart('SELECT id, internal_code FROM part WHERE deleted_at IS NULL AND lower(internal_code) = lower($1) ORDER BY created_at DESC, id DESC LIMIT 1', [partInternalCode(base, revision)])
      : await findPart(
        "SELECT id, internal_code FROM part WHERE deleted_at IS NULL AND left(lower(internal_code), length($1) + 1) = lower($1) || '.' ORDER BY created_at DESC, id DESC LIMIT 1",
        [base],
      );
    if (!found) {
      found = await findPart(
        `SELECT p.id, p.internal_code FROM drawing d
           JOIN drawing_part dp ON dp.drawing_id = d.id
           JOIN part p ON p.id = dp.part_id AND p.deleted_at IS NULL
          WHERE d.deleted_at IS NULL AND lower(d.code) = lower($1) AND d.revision = $2
          ORDER BY dp.position, dp.id LIMIT 1`,
        [base, revision ?? DEFAULT_REVISION],
      );
    }
    if (found) return Object.assign(row, { partId: found.id, partCode: found.internalCode });

    const rev = revision ?? DEFAULT_REVISION;
    const internalCode = partInternalCode(base, rev);
    const already = plannedNew.get(internalCode.toLowerCase());
    if (already) {
      row.newPart = already;
      return;
    }
    let materialId: number | null = null;
    let materialName: string | null = null;
    if (materialText) {
      const m: { id: number; name: string }[] = await em.query(
        'SELECT id, name FROM material WHERE deleted_at IS NULL AND (lower(code) = lower($1) OR lower(name) = lower($1)) ORDER BY (lower(code) = lower($1)) DESC, id LIMIT 1',
        [materialText],
      );
      if (m.length) [materialId, materialName] = [Number(m[0].id), m[0].name];
      else row.warnings.push(`Materiale "${materialText}" non trovato: il particolare nuovo nasce senza materiale.`);
    }
    if (!revision) row.warnings.push(`Revisione non indicata per ${base}: il disegno nuovo nasce con revisione ${DEFAULT_REVISION}.`);
    row.newPart = { drawingCode: base, revision: rev, internalCode, name: fromDescr.revision ? fromDescr.name : row.description, materialId, materialName };
    plannedNew.set(internalCode.toLowerCase(), row.newPart);
  }

  /** Scrive tutto in una transazione: file, preventivo, disegni/particolari nuovi, righe. */
  private async save(em: EntityManager, report: ImportReport, f: { file: Express.Multer.File; storedName: string; userId?: number }): Promise<number> {
    const h = report.header;
    const fileRow = await em.getRepository(FileAttachment).save(
      em.getRepository(FileAttachment).create({
        ownerUserId: f.userId ?? null, originalName: f.file.originalname, storedName: f.storedName, mimeType: f.file.mimetype || MIME_XLSX,
        sizeBytes: f.file.size, description: 'Excel preventivo importato', entity: 'quote', entityId: null,
      }),
    );
    const quote = await em.getRepository(Quote).save(
      em.getRepository(Quote).create({
        number: h.number, customerId: h.customerId!, issueDate: new Date().toISOString().slice(0, 10), expectedDeliveryDate: h.expectedDeliveryDate,
        materialMarkup: h.materialMarkup!, markup: h.markup!, importedFileId: fileRow.id, notes: null,
      }),
    );
    await em.getRepository(FileAttachment).update(fileRow.id, { entityId: quote.id });

    const created = new Map<string, number>();
    let sort = 0;
    for (const row of report.rows) {
      let partId = row.partId;
      if (!partId && row.newPart) {
        const key = row.newPart.internalCode.toLowerCase();
        partId = created.get(key) ?? (await this.createDrawingAndPart(em, row.newPart));
        created.set(key, partId);
      }
      if (!partId) throw new BadRequestException(`Riga ${row.row}: particolare non determinato.`);
      await this.quotes.insertPart(em, quote, {
        partId,
        quantity: row.quantity ?? 0,
        productionQuantity: row.productionQuantity ?? 0,
        camSeconds: row.camSeconds,
        notes: row.notes,
        sortOrder: ++sort,
        phases: row.phases.map((p, i) => ({
          machineTypeId: p.machineTypeId!, machineId: p.machineId, sequence: i + 1,
          programmingSeconds: p.programmingSeconds, setupSeconds: p.setupSeconds, unitSeconds: p.unitSeconds,
        })),
      });
    }
    await writeAudit(em, 'quote', 'CREATE', quote.id, { number: quote.number, file: f.file.originalname, rows: report.rows.length }, `Preventivo ${quote.number} importato da Excel`);
    return quote.id;
  }

  private async createDrawingAndPart(em: EntityManager, np: NonNullable<ImportRowPlan['newPart']>): Promise<number> {
    const drawing = await em.getRepository(Drawing).save(em.getRepository(Drawing).create({ code: np.drawingCode, revision: np.revision, name: np.name, notes: null }));
    const part = await em.getRepository(Part).save(em.getRepository(Part).create({ internalCode: np.internalCode, name: np.name, materialId: np.materialId }));
    await em.getRepository(DrawingPart).save({ drawingId: drawing.id, partId: part.id, quantity: 1, position: 1 });
    await writeAudit(em, 'drawing', 'CREATE', drawing.id, { code: np.drawingCode, revision: np.revision }, 'Creato dall\'import Excel di un preventivo');
    return part.id;
  }
}
