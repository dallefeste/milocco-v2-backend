import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/** Impostazione dell'applicazione (chiave → valore JSON). */
@Entity('app_setting')
export class Setting {
  @PrimaryColumn()
  key!: string;

  @Column({ type: 'jsonb', nullable: true })
  value!: unknown;

  @Column()
  label!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
