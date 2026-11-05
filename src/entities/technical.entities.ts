import { Column, Entity, JoinColumn, JoinTable, ManyToMany, ManyToOne, OneToMany } from 'typeorm';
import { AppBaseEntity, AppPlainEntity } from '../common/entities/base.entity';
import { numeric } from '../common/entities/transformers';
import { BarType, MachineType, Material, Supplier, Treatment } from './masterdata.entities';

@Entity('drawing')
export class Drawing extends AppBaseEntity {
  @Column() code!: string;
  @Column({ default: '' }) revision!: string;
  @Column({ default: '' }) name!: string;
  @Column({ type: 'text', nullable: true }) notes!: string | null;
  @OneToMany(() => DrawingPart, (dp) => dp.drawing, { cascade: true }) parts?: DrawingPart[];
  @ManyToMany(() => Treatment)
  @JoinTable({ name: 'drawing_treatment', joinColumn: { name: 'drawing_id' }, inverseJoinColumn: { name: 'treatment_id' } })
  treatments?: Treatment[];
}

@Entity('part')
export class Part extends AppBaseEntity {
  @Column() internalCode!: string;
  @Column({ default: '' }) name!: string;
  @Column({ type: 'int', nullable: true }) materialId!: number | null;
  @ManyToOne(() => Material) @JoinColumn({ name: 'material_id' }) material?: Material | null;
  @Column({ type: 'int', nullable: true }) supplierId!: number | null;
  @ManyToOne(() => Supplier) @JoinColumn({ name: 'supplier_id' }) supplier?: Supplier | null;
  /** Testo dimensioni (es. "Barra circolare - d50 L43"). */
  @Column({ type: 'text', nullable: true }) dimensions!: string | null;
  /** Forma del calcolatore peso (chiave, es. 'ROUND_BAR'). */
  @Column({ type: 'text', nullable: true }) shape!: string | null;
  /** Misure in mm della forma (es. { d: 50, L: 43 }). */
  @Column({ type: 'jsonb', nullable: true }) shapeParams!: Record<string, number> | null;
  /** Lunghezza di taglio in mm (parametro L). */
  @Column({ type: 'numeric', nullable: true, transformer: numeric }) cutLengthMm!: number | null;
  @Column({ type: 'numeric', nullable: true, transformer: numeric }) weightKg!: number | null;
  @Column({ type: 'numeric', nullable: true, transformer: numeric }) treatmentDm2!: number | null;
  @Column({ type: 'numeric', nullable: true, transformer: numeric }) treatmentKg!: number | null;
  @Column({ type: 'text', nullable: true }) notes!: string | null;
  @Column({ default: false }) barCut!: boolean;
  @Column({ type: 'int', nullable: true }) barTypeId!: number | null;
  @ManyToOne(() => BarType) @JoinColumn({ name: 'bar_type_id' }) barType?: BarType | null;
  @OneToMany(() => PartCycleStep, (s) => s.part, { cascade: true }) cycle?: PartCycleStep[];
}

@Entity('drawing_part')
export class DrawingPart extends AppPlainEntity {
  @Column() drawingId!: number;
  @ManyToOne(() => Drawing, (d) => d.parts, { onDelete: 'CASCADE' }) @JoinColumn({ name: 'drawing_id' }) drawing?: Drawing;
  @Column() partId!: number;
  @ManyToOne(() => Part) @JoinColumn({ name: 'part_id' }) part?: Part;
  /** Pezzi di questo particolare per una unità di disegno. */
  @Column({ default: 1 }) quantity!: number;
  /** Numero di posizione nella tavola. */
  @Column({ default: 1 }) position!: number;
}

@Entity('part_cycle_step')
export class PartCycleStep extends AppPlainEntity {
  @Column() partId!: number;
  @ManyToOne(() => Part, (p) => p.cycle, { onDelete: 'CASCADE' }) @JoinColumn({ name: 'part_id' }) part?: Part;
  @Column() machineTypeId!: number;
  @ManyToOne(() => MachineType) @JoinColumn({ name: 'machine_type_id' }) machineType?: MachineType;
  @Column({ default: 1 }) sequence!: number;
  @Column({ default: 0 }) setupSeconds!: number;
  /** Tempo per pezzo. */
  @Column({ default: 0 }) unitSeconds!: number;
  @Column({ type: 'int', nullable: true }) plannedManMinutes!: number | null;
}
