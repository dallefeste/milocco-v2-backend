import { Column, Entity, JoinColumn, ManyToOne, OneToMany } from 'typeorm';
import type { OrderLineStatus, TreatmentPriceUnit } from '../shared';
import { AppBaseEntity, AppPlainEntity } from '../common/entities/base.entity';
import { numeric } from '../common/entities/transformers';
import { Customer, Machine, MachineType, Treatment } from './masterdata.entities';
import { Drawing, Part } from './technical.entities';

@Entity('file_attachment')
export class FileAttachment extends AppBaseEntity {
  @Column({ type: 'int', nullable: true }) ownerUserId!: number | null;
  @Column() originalName!: string;
  @Column() storedName!: string;
  @Column({ type: 'text', nullable: true }) mimeType!: string | null;
  @Column({ type: 'bigint', nullable: true, transformer: numeric }) sizeBytes!: number | null;
  @Column({ type: 'text', nullable: true }) description!: string | null;
  @Column({ type: 'text', nullable: true }) entity!: string | null;
  @Column({ type: 'int', nullable: true }) entityId!: number | null;
}

@Entity('customer_order')
export class CustomerOrder extends AppBaseEntity {
  @Column() code!: string;
  @Column() customerId!: number;
  @ManyToOne(() => Customer) @JoinColumn({ name: 'customer_id' }) customer?: Customer;
  @Column({ type: 'timestamptz' }) orderDate!: Date;
  @Column({ type: 'text', nullable: true }) notes!: string | null;
  @OneToMany(() => CustomerOrderLine, (l) => l.customerOrder, { cascade: true }) lines?: CustomerOrderLine[];
}

@Entity('customer_order_line')
export class CustomerOrderLine extends AppBaseEntity {
  @Column() customerOrderId!: number;
  @ManyToOne(() => CustomerOrder, (o) => o.lines, { onDelete: 'CASCADE' }) @JoinColumn({ name: 'customer_order_id' }) customerOrder?: CustomerOrder;
  @Column() drawingId!: number;
  @ManyToOne(() => Drawing) @JoinColumn({ name: 'drawing_id' }) drawing?: Drawing;
  @Column() quantity!: number;
  @Column({ type: 'text', default: 'PENDING' }) status!: OrderLineStatus;
  @Column({ type: 'text', nullable: true }) notes!: string | null;
}

@Entity('quote')
export class Quote extends AppBaseEntity {
  @Column() number!: string;
  @Column() customerId!: number;
  @ManyToOne(() => Customer) @JoinColumn({ name: 'customer_id' }) customer?: Customer;
  @Column({ type: 'date' }) issueDate!: string;
  @Column({ type: 'date', nullable: true }) expectedDeliveryDate!: string | null;
  @Column({ type: 'numeric', transformer: numeric, default: 1.15 }) materialMarkup!: number;
  @Column({ type: 'numeric', transformer: numeric, default: 1.25 }) markup!: number;
  @Column({ type: 'int', nullable: true }) customerOrderId!: number | null;
  @ManyToOne(() => CustomerOrder) @JoinColumn({ name: 'customer_order_id' }) customerOrder?: CustomerOrder | null;
  @Column({ type: 'int', nullable: true }) importedFileId!: number | null;
  @Column({ type: 'text', nullable: true }) notes!: string | null;
  @OneToMany(() => QuotePart, (p) => p.quote) parts?: QuotePart[];
}

@Entity('quote_part')
export class QuotePart extends AppBaseEntity {
  @Column() quoteId!: number;
  @ManyToOne(() => Quote, (q) => q.parts, { onDelete: 'CASCADE' }) @JoinColumn({ name: 'quote_id' }) quote?: Quote;
  @Column() partId!: number;
  @ManyToOne(() => Part) @JoinColumn({ name: 'part_id' }) part?: Part;
  /** Quantità ordinata (informativa). */
  @Column({ default: 0 }) quantity!: number;
  /** Quantità del lotto: su questa si ripartiscono i tempi fissi. */
  @Column({ default: 0 }) productionQuantity!: number;
  @Column({ default: 0 }) camSeconds!: number;
  @Column({ type: 'numeric', transformer: numeric, default: 0 }) camPricePerMinute!: number;
  @Column({ type: 'numeric', transformer: numeric, default: 0 }) materialPricePerKg!: number;
  /** Copie dei dati del particolare al momento del preventivo. */
  @Column({ type: 'numeric', nullable: true, transformer: numeric }) weightKg!: number | null;
  @Column({ type: 'numeric', nullable: true, transformer: numeric }) treatmentKg!: number | null;
  @Column({ type: 'numeric', nullable: true, transformer: numeric }) treatmentDm2!: number | null;
  @Column({ type: 'text', nullable: true }) notes!: string | null;
  @Column({ default: 0 }) sortOrder!: number;
  @OneToMany(() => QuotePartPhase, (p) => p.quotePart, { cascade: true }) phases?: QuotePartPhase[];
  @OneToMany(() => QuotePartTreatment, (t) => t.quotePart, { cascade: true }) treatments?: QuotePartTreatment[];
}

@Entity('quote_part_phase')
export class QuotePartPhase extends AppPlainEntity {
  @Column() quotePartId!: number;
  @ManyToOne(() => QuotePart, (p) => p.phases, { onDelete: 'CASCADE' }) @JoinColumn({ name: 'quote_part_id' }) quotePart?: QuotePart;
  @Column() machineTypeId!: number;
  @ManyToOne(() => MachineType) @JoinColumn({ name: 'machine_type_id' }) machineType?: MachineType;
  @Column({ type: 'int', nullable: true }) machineId!: number | null;
  @ManyToOne(() => Machine) @JoinColumn({ name: 'machine_id' }) machine?: Machine | null;
  @Column({ default: 1 }) sequence!: number;
  @Column({ default: 0 }) programmingSeconds!: number;
  @Column({ default: 0 }) setupSeconds!: number;
  @Column({ default: 0 }) unitSeconds!: number;
  @Column({ type: 'numeric', transformer: numeric, default: 0 }) machineHourlyRate!: number;
}

@Entity('quote_part_treatment')
export class QuotePartTreatment extends AppPlainEntity {
  @Column() quotePartId!: number;
  @ManyToOne(() => QuotePart, (p) => p.treatments, { onDelete: 'CASCADE' }) @JoinColumn({ name: 'quote_part_id' }) quotePart?: QuotePart;
  @Column() treatmentId!: number;
  @ManyToOne(() => Treatment) @JoinColumn({ name: 'treatment_id' }) treatment?: Treatment;
  @Column({ type: 'numeric', transformer: numeric, default: 0 }) unitPrice!: number;
  @Column({ type: 'text', default: 'KG' }) unit!: TreatmentPriceUnit;
}
