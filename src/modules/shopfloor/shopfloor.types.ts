/** Risposte delle API /shopfloor (stesse forme in tablet/src/api/types.ts). */
import type { CutStatus, ProductionOrderStatus, ScheduleItemStatus, WorkPhaseStatus } from '../../shared';

export interface StationView {
  id: number;
  name: string;
  machineTypeName: string;
  isCutting: boolean;
  isInspection: boolean;
}

export interface OperatorView {
  id: number;
  firstName: string;
  lastName: string;
  fullName: string;
  hasPin: boolean;
}

export interface OrderHeader {
  productionOrderId: number;
  status: ProductionOrderStatus;
  customerId: number;
  customerName: string;
  customerOrderCode: string;
  drawingId: number;
  drawingCode: string;
  drawingRevision: string;
  orderQuantity: number;
  expectedDeliveryDate: string | null;
}

export interface PartHeader {
  partId: number;
  internalCode: string;
  name: string;
  materialName: string | null;
  quantityPerUnit: number;
  /** quantità ordine × quantità per disegno */
  totalQuantity: number;
  barCut: boolean;
  barTypeId: number | null;
  barTypeCode: string | null;
}

export interface NextPlannedView {
  scheduleItemId: number;
  status: ScheduleItemStatus;
  order: OrderHeader;
  part: PartHeader;
  setupSeconds: number;
  unitSeconds: number;
}

export interface CustomerView {
  id: number;
  name: string;
  orderCount: number;
}

export interface SubgroupView {
  name: string;
  orderCount: number;
}

export interface OrderListItem {
  id: number;
  status: ProductionOrderStatus;
  quantity: number;
  drawingId: number;
  drawingCode: string;
  drawingRevision: string;
  customerOrderCode: string;
  expectedDeliveryDate: string | null;
  partCount: number;
}

export interface OrderGroupView {
  key: string;
  label: string;
  orders: OrderListItem[];
}

export interface OrderPartView extends PartHeader {
  goodDone: number;
  openPhases: number;
}

export interface PhaseView {
  id: number;
  productionOrderId: number;
  phaseNumber: number;
  status: WorkPhaseStatus;
  operatorId: number;
  operatorName: string;
  machineId: number;
  machineName: string;
  partId: number | null;
  partCode: string | null;
  goodQty: number | null;
  scrapQty: number | null;
  setupStartedAt: string;
  setupEndedAt: string | null;
  workStartedAt: string | null;
  workEndedAt: string | null;
  avgUnitSeconds: number | null;
  resumedFromId: number | null;
  scheduleItemId: number | null;
  /** Solo per le sospese: già ripresa da un'altra fase. */
  resumed: boolean;
}

export interface PhaseGroups {
  inProgress: PhaseView[];
  completed: PhaseView[];
  suspended: PhaseView[];
}

export interface OrderSummaryView {
  order: OrderHeader;
  part: PartHeader;
  phases: PhaseGroups;
}

export interface InspectionView {
  id: number;
  productionOrderId: number;
  operatorId: number;
  operatorName: string;
  startedAt: string;
  endedAt: string | null;
  goodQty: number | null;
  scrapQty: number | null;
  notes: string | null;
}

export interface InspectionSummaryView {
  order: OrderHeader;
  treatments: string[];
  phases: PhaseGroups;
  totals: { goodQty: number; scrapQty: number };
  inspections: InspectionView[];
}

export interface StopView {
  id: number;
  workPhaseId: number;
  stopReasonId: number | null;
  stopReasonName: string | null;
  machineStopped: boolean;
  startedAt: string;
  endedAt: string | null;
}

export interface ActivePhaseView {
  phase: PhaseView;
  order: OrderHeader;
  part: PartHeader;
  openStop: StopView | null;
}

export interface ShopState {
  /** Fase aperta da questo operatore su questa postazione. */
  phase: ActivePhaseView | null;
  /** Collaudo non concluso (aperto, o chiuso senza pezzi) dell'operatore su questa postazione. */
  inspection: (InspectionView & { order: OrderHeader }) | null;
  extraActivity: { id: number; extraActivityId: number; name: string; startedAt: string; endedAt: string | null } | null;
  /** Altre fasi aperte sulla postazione (di altri operatori). */
  otherPhases: ActivePhaseView[];
}

export interface CutQueueView {
  id: number;
  position: number;
  status: CutStatus;
  order: OrderHeader;
  part: PartHeader;
  shapeName: string;
  shapeFamily: string;
  size: string;
  dimensions: string | null;
  notes: string | null;
  /** Testo "n barre da l mm (Pezzi per barra: N)", solo per taglio a barra. */
  barPlan: { ok: boolean; text: string; bars: number; barLengthMm: number; piecesPerBar: number } | null;
  stockMm: number | null;
}

export interface BarTypeView {
  id: number;
  code: string;
  materialId: number | null;
  materialName: string | null;
  finishId: number | null;
  finishName: string | null;
  shape: string;
  shapeLabel: string;
  dimensions: string;
  stockMm: number;
}

export interface NamedItem {
  id: number;
  name: string;
}

export interface StopReasonView extends NamedItem {
  endsWorkday: boolean;
  kind: string;
}
