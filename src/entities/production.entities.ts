import { Column, Entity, JoinColumn, JoinTable, ManyToMany, ManyToOne, OneToMany } from 'typeorm';
import type { CutStatus, PartCutStatus, ProductionOrderStatus, ScheduleItemStatus, WorkPhaseStatus } from '../shared';
import { AppBaseEntity, AppPlainEntity } from '../common/entities/base.entity';
import { numeric } from '../common/entities/transformers';
import { ExtraActivity, Machine, Operator, StopReason, Treatment } from './masterdata.entities';
import { CustomerOrder, CustomerOrderLine } from './sales.entities';
import { Drawing, Part } from './technical.entities';

/** Ordine di produzione: l'id è il numero d'ordine mostrato all'utente. */
@Entity('production_order')
export class ProductionOrder extends AppBaseEntity {
  @Column() customerOrderId!: number;
  @ManyToOne(() => CustomerOrder) @JoinColumn({ name: 'customer_order_id' }) customerOrder?: CustomerOrder;
  @Column({ type: 'int', nullable: true }) customerOrderLineId!: number | null;
  @ManyToOne(() => CustomerOrderLine) @JoinColumn({ name: 'customer_order_line_id' }) customerOrderLine?: CustomerOrderLine | null;
  @Column() drawingId!: number;
  @ManyToOne(() => Drawing) @JoinColumn({ name: 'drawing_id' }) drawing?: Drawing;
  @Column() quantity!: number;
  @Column({ default: 0 }) stockQuantity!: number;
  @Column({ type: 'date', nullable: true }) expectedDeliveryDate!: string | null;
  @Column({ type: 'text', default: 'TO_DO' }) status!: ProductionOrderStatus;
  @Column({ type: 'timestamptz', nullable: true }) startedAt!: Date | null;
  @Column({ type: 'timestamptz', nullable: true }) completedAt!: Date | null;
  @Column({ type: 'text', nullable: true }) notes!: string | null;
  @ManyToMany(() => Treatment)
  @JoinTable({ name: 'production_order_treatment', joinColumn: { name: 'production_order_id' }, inverseJoinColumn: { name: 'treatment_id' } })
  treatments?: Treatment[];
  @OneToMany(() => ProductionOrderPart, (p) => p.productionOrder) parts?: ProductionOrderPart[];
}

@Entity('production_order_part')
export class ProductionOrderPart extends AppPlainEntity {
  @Column() productionOrderId!: number;
  @ManyToOne(() => ProductionOrder, (o) => o.parts, { onDelete: 'CASCADE' }) @JoinColumn({ name: 'production_order_id' }) productionOrder?: ProductionOrder;
  @Column() partId!: number;
  @ManyToOne(() => Part) @JoinColumn({ name: 'part_id' }) part?: Part;
  @Column({ default: 1 }) quantityPerUnit!: number;
  @Column({ type: 'text', default: 'NONE' }) cutStatus!: PartCutStatus;
}

/** Lavorazione pianificata su una macchina. */
@Entity('schedule_item')
export class ScheduleItem extends AppBaseEntity {
  @Column() productionOrderId!: number;
  @ManyToOne(() => ProductionOrder) @JoinColumn({ name: 'production_order_id' }) productionOrder?: ProductionOrder;
  @Column() partId!: number;
  @ManyToOne(() => Part) @JoinColumn({ name: 'part_id' }) part?: Part;
  @Column() machineId!: number;
  @ManyToOne(() => Machine) @JoinColumn({ name: 'machine_id' }) machine?: Machine;
  @Column({ default: 0 }) setupSeconds!: number;
  /** Tempo per pezzo. */
  @Column({ default: 0 }) unitSeconds!: number;
  @Column({ default: 0 }) internalPauseSeconds!: number;
  @Column({ default: 0 }) endPauseSeconds!: number;
  /** Pezzi da produrre. */
  @Column({ default: 0 }) quantity!: number;
  @Column({ type: 'numeric', transformer: numeric, default: 0 }) position!: number;
  @Column({ type: 'text', default: 'OPEN' }) status!: ScheduleItemStatus;
  @Column({ type: 'timestamptz', nullable: true }) completedAt!: Date | null;
}

@Entity('cut_queue_item')
export class CutQueueItem extends AppBaseEntity {
  @Column() productionOrderId!: number;
  @ManyToOne(() => ProductionOrder) @JoinColumn({ name: 'production_order_id' }) productionOrder?: ProductionOrder;
  @Column({ type: 'int', nullable: true }) productionOrderPartId!: number | null;
  @ManyToOne(() => ProductionOrderPart, { onDelete: 'SET NULL' }) @JoinColumn({ name: 'production_order_part_id' }) productionOrderPart?: ProductionOrderPart | null;
  @Column() partId!: number;
  @ManyToOne(() => Part) @JoinColumn({ name: 'part_id' }) part?: Part;
  @Column({ type: 'numeric', transformer: numeric, default: 0 }) position!: number;
  @Column({ type: 'text', default: 'WAITING' }) status!: CutStatus;
  @Column({ type: 'timestamptz', nullable: true }) startedAt!: Date | null;
  @Column({ type: 'timestamptz', nullable: true }) completedAt!: Date | null;
}

/** Fase eseguita in reparto (attrezzaggio + lavorazione). */
@Entity('work_phase')
export class WorkPhase extends AppBaseEntity {
  @Column() productionOrderId!: number;
  @ManyToOne(() => ProductionOrder) @JoinColumn({ name: 'production_order_id' }) productionOrder?: ProductionOrder;
  @Column({ type: 'int', nullable: true }) partId!: number | null;
  @ManyToOne(() => Part) @JoinColumn({ name: 'part_id' }) part?: Part | null;
  @Column() operatorId!: number;
  @ManyToOne(() => Operator) @JoinColumn({ name: 'operator_id' }) operator?: Operator;
  @Column() machineId!: number;
  @ManyToOne(() => Machine) @JoinColumn({ name: 'machine_id' }) machine?: Machine;
  @Column({ type: 'int', nullable: true }) scheduleItemId!: number | null;
  @ManyToOne(() => ScheduleItem) @JoinColumn({ name: 'schedule_item_id' }) scheduleItem?: ScheduleItem | null;
  @Column({ default: 1 }) phaseNumber!: number;
  @Column({ type: 'int', nullable: true }) resumedFromId!: number | null;
  @Column({ type: 'text', default: 'IN_PROGRESS' }) status!: WorkPhaseStatus;
  @Column({ type: 'timestamptz' }) setupStartedAt!: Date;
  @Column({ type: 'timestamptz', nullable: true }) setupEndedAt!: Date | null;
  @Column({ type: 'timestamptz', nullable: true }) workStartedAt!: Date | null;
  @Column({ type: 'timestamptz', nullable: true }) workEndedAt!: Date | null;
  @Column({ type: 'int', nullable: true }) goodQty!: number | null;
  @Column({ type: 'int', nullable: true }) scrapQty!: number | null;
  @Column({ type: 'numeric', nullable: true, transformer: numeric }) avgUnitSeconds!: number | null;
  @OneToMany(() => WorkStop, (s) => s.workPhase) stops?: WorkStop[];
}

@Entity('work_stop')
export class WorkStop extends AppBaseEntity {
  @Column() workPhaseId!: number;
  @ManyToOne(() => WorkPhase, (p) => p.stops) @JoinColumn({ name: 'work_phase_id' }) workPhase?: WorkPhase;
  @Column({ type: 'int', nullable: true }) stopReasonId!: number | null;
  @ManyToOne(() => StopReason) @JoinColumn({ name: 'stop_reason_id' }) stopReason?: StopReason | null;
  @Column({ type: 'timestamptz' }) startedAt!: Date;
  @Column({ type: 'timestamptz', nullable: true }) endedAt!: Date | null;
  /** true = macchina ferma; false = pausa operatore con macchina in lavorazione. */
  @Column({ default: true }) machineStopped!: boolean;
}

@Entity('extra_activity_log')
export class ExtraActivityLog extends AppBaseEntity {
  @Column() operatorId!: number;
  @ManyToOne(() => Operator) @JoinColumn({ name: 'operator_id' }) operator?: Operator;
  @Column() extraActivityId!: number;
  @ManyToOne(() => ExtraActivity) @JoinColumn({ name: 'extra_activity_id' }) extraActivity?: ExtraActivity;
  @Column({ type: 'int', nullable: true }) machineId!: number | null;
  @ManyToOne(() => Machine) @JoinColumn({ name: 'machine_id' }) machine?: Machine | null;
  @Column({ type: 'timestamptz' }) startedAt!: Date;
  @Column({ type: 'timestamptz', nullable: true }) endedAt!: Date | null;
}

@Entity('inspection')
export class Inspection extends AppBaseEntity {
  @Column() productionOrderId!: number;
  @ManyToOne(() => ProductionOrder) @JoinColumn({ name: 'production_order_id' }) productionOrder?: ProductionOrder;
  @Column() operatorId!: number;
  @ManyToOne(() => Operator) @JoinColumn({ name: 'operator_id' }) operator?: Operator;
  @Column({ type: 'int', nullable: true }) machineId!: number | null;
  @ManyToOne(() => Machine) @JoinColumn({ name: 'machine_id' }) machine?: Machine | null;
  @Column({ type: 'timestamptz' }) startedAt!: Date;
  @Column({ type: 'timestamptz', nullable: true }) endedAt!: Date | null;
  @Column({ type: 'int', nullable: true }) goodQty!: number | null;
  @Column({ type: 'int', nullable: true }) scrapQty!: number | null;
  @Column({ type: 'text', nullable: true }) notes!: string | null;
}

@Entity('operator_session')
export class OperatorSession extends AppPlainEntity {
  @Column() operatorId!: number;
  @ManyToOne(() => Operator) @JoinColumn({ name: 'operator_id' }) operator?: Operator;
  @Column({ type: 'int', nullable: true }) machineId!: number | null;
  @ManyToOne(() => Machine) @JoinColumn({ name: 'machine_id' }) machine?: Machine | null;
  @Column({ type: 'timestamptz' }) startedAt!: Date;
  @Column({ type: 'timestamptz', nullable: true }) endedAt!: Date | null;
}
