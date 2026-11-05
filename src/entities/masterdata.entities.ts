import { Column, Entity, JoinColumn, ManyToOne, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import type { StopKind, TreatmentPriceUnit } from '../shared';
import { AppBaseEntity, AppPlainEntity } from '../common/entities/base.entity';
import { numeric } from '../common/entities/transformers';

@Entity('customer')
export class Customer extends AppBaseEntity {
  @Column() name!: string;
  @Column({ type: 'text', nullable: true }) notes!: string | null;
}

@Entity('supplier')
export class Supplier extends AppBaseEntity {
  @Column() name!: string;
  @Column({ type: 'text', nullable: true }) notes!: string | null;
}

@Entity('department')
export class Department extends AppBaseEntity {
  @Column() name!: string;
  /** I suoi operatori usano il tablet e compaiono nei riepiloghi giornalieri. */
  @Column({ default: false }) isProduction!: boolean;
}

@Entity('operator')
export class Operator extends AppBaseEntity {
  @Column() firstName!: string;
  @Column() lastName!: string;
  @Column({ type: 'int', nullable: true }) departmentId!: number | null;
  @ManyToOne(() => Department) @JoinColumn({ name: 'department_id' }) department?: Department | null;
  @Column({ type: 'text', nullable: true }) badgeNumber!: string | null;
  @Column({ type: 'date', nullable: true }) birthDate!: string | null;
  @Column({ type: 'date', nullable: true }) hireDate!: string | null;
  @Column({ default: true }) active!: boolean;
  @Column({ type: 'text', nullable: true, select: false }) pinHash!: string | null;
}

@Entity('machine_type')
export class MachineType extends AppBaseEntity {
  @Column() name!: string;
  /** Fase di taglio barre. */
  @Column({ default: false }) isCutting!: boolean;
  /** Fase di collaudo. */
  @Column({ default: false }) isInspection!: boolean;
  /** Proposta in pianificazione alla conferma dell'ordine cliente. */
  @Column({ default: false }) planOnOrderConfirm!: boolean;
  /** Colonna dell'export Excel del preventivo (es. 'FRESATURA'). */
  @Column({ type: 'text', nullable: true }) excelColumn!: string | null;
  @Column({ default: 100 }) sortOrder!: number;
}

@Entity('machine')
export class Machine extends AppBaseEntity {
  @Column() name!: string;
  @Column() machineTypeId!: number;
  @ManyToOne(() => MachineType) @JoinColumn({ name: 'machine_type_id' }) machineType?: MachineType;
  @Column({ type: 'numeric', transformer: numeric, default: 0 }) hourlyRate!: number;
  /** Compare nella pianificazione (code per macchina). */
  @Column({ default: false }) schedulable!: boolean;
  @Column({ default: 100 }) sortOrder!: number;
}

@Entity('customer_machine_rate')
export class CustomerMachineRate extends AppPlainEntity {
  @Column() machineId!: number;
  @ManyToOne(() => Machine, { onDelete: 'CASCADE' }) @JoinColumn({ name: 'machine_id' }) machine?: Machine;
  @Column() customerId!: number;
  @ManyToOne(() => Customer, { onDelete: 'CASCADE' }) @JoinColumn({ name: 'customer_id' }) customer?: Customer;
  @Column({ type: 'numeric', transformer: numeric }) hourlyRate!: number;
}

@Entity('material')
export class Material extends AppBaseEntity {
  @Column() name!: string;
  @Column({ type: 'text', nullable: true }) code!: string | null;
  /** g/cm³ */
  @Column({ type: 'numeric', transformer: numeric, default: 0 }) density!: number;
  /** €/kg */
  @Column({ type: 'numeric', transformer: numeric, default: 0 }) pricePerKg!: number;
}

@Entity('finish')
export class Finish extends AppBaseEntity {
  @Column() name!: string;
  @Column() code!: string;
}

@Entity('treatment')
export class Treatment extends AppBaseEntity {
  @Column() name!: string;
  @Column({ default: 0 }) requiredDays!: number;
  @Column({ type: 'numeric', nullable: true, transformer: numeric }) unitPrice!: number | null;
  @Column({ type: 'text', nullable: true }) unit!: TreatmentPriceUnit | null;
}

@Entity('stop_reason')
export class StopReason extends AppBaseEntity {
  @Column() name!: string;
  @Column({ type: 'text', nullable: true }) description!: string | null;
  @Column({ type: 'text', default: 'INTERRUPTION' }) kind!: StopKind;
  /** Causale di fine giornata: sospende automaticamente la fase. */
  @Column({ default: false }) endsWorkday!: boolean;
  @Column({ default: 100 }) sortOrder!: number;
}

@Entity('extra_activity')
export class ExtraActivity extends AppBaseEntity {
  @Column() name!: string;
}

@Entity('work_calendar_day')
export class WorkCalendarDay {
  /** 0 = lunedì … 6 = domenica */
  @PrimaryColumn({ type: 'smallint' }) weekday!: number;
  /** 'HH:MM:SS' o null se giorno di chiusura */
  @Column({ type: 'time', nullable: true }) startTime!: string | null;
  @Column({ type: 'time', nullable: true }) endTime!: string | null;
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt!: Date;
}

@Entity('work_calendar_closure')
export class WorkCalendarClosure extends AppPlainEntity {
  @Column({ type: 'date' }) day!: string;
  @Column({ type: 'text', nullable: true }) reason!: string | null;
}

@Entity('bar_type')
export class BarType extends AppBaseEntity {
  /** MP + codice materiale + forma + finitura + dimensioni */
  @Column() code!: string;
  @Column({ type: 'int', nullable: true }) materialId!: number | null;
  @ManyToOne(() => Material) @JoinColumn({ name: 'material_id' }) material?: Material | null;
  @Column() shape!: string;
  @Column({ type: 'int', nullable: true }) finishId!: number | null;
  @ManyToOne(() => Finish) @JoinColumn({ name: 'finish_id' }) finish?: Finish | null;
  @Column({ default: '' }) dimensions!: string;
}

@Entity('bar_stock')
export class BarStock extends AppPlainEntity {
  @Column() barTypeId!: number;
  @ManyToOne(() => BarType) @JoinColumn({ name: 'bar_type_id' }) barType?: BarType;
  @Column({ type: 'numeric', transformer: numeric, default: 0 }) meters!: number;
  @Column({ type: 'text', nullable: true }) description!: string | null;
}

@Entity('bar_stock_movement')
export class BarStockMovement extends AppPlainEntity {
  @Column() barTypeId!: number;
  @ManyToOne(() => BarType) @JoinColumn({ name: 'bar_type_id' }) barType?: BarType;
  @Column({ type: 'text' }) kind!: 'LOAD' | 'UNLOAD' | 'ADJUST';
  @Column({ type: 'numeric', transformer: numeric }) meters!: number;
  @Column({ type: 'numeric', nullable: true, transformer: numeric }) metersAfter!: number | null;
  @Column({ type: 'text', nullable: true }) reason!: string | null;
  @Column({ type: 'int', nullable: true }) productionOrderId!: number | null;
  @Column({ type: 'int', nullable: true }) operatorId!: number | null;
  @ManyToOne(() => Operator) @JoinColumn({ name: 'operator_id' }) operator?: Operator | null;
  @Column({ type: 'int', nullable: true }) userId!: number | null;
}
