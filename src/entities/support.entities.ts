import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { User } from '../modules/users/user.entity';
import type { TicketPriority, TicketStatus } from '../shared';
import { AppBaseEntity } from '../common/entities/base.entity';

@Entity('support_ticket')
export class SupportTicket extends AppBaseEntity {
  @Column({ type: 'text', nullable: true }) code!: string | null;
  @Column({ type: 'int', nullable: true }) userId!: number | null;
  @ManyToOne(() => User) @JoinColumn({ name: 'user_id' }) user?: User | null;
  @Column() subject!: string;
  @Column({ type: 'text', default: 'MEDIUM' }) priority!: TicketPriority;
  @Column() description!: string;
  @Column({ type: 'text', nullable: true }) suggestion!: string | null;
  @Column({ type: 'text', nullable: true }) feedback!: string | null;
  @Column({ type: 'text', default: 'OPEN' }) status!: TicketStatus;
}

@Entity('audit_log')
export class AuditLog {
  @PrimaryGeneratedColumn({ type: 'bigint' }) id!: string;
  @Column({ type: 'int', nullable: true }) userId!: number | null;
  @Column({ type: 'text', nullable: true }) username!: string | null;
  @Column() entity!: string;
  @Column({ type: 'text', nullable: true }) entityId!: string | null;
  @Column({ type: 'text' }) action!: 'CREATE' | 'UPDATE' | 'DELETE' | 'RESTORE' | 'ACTION';
  @Column({ type: 'text', nullable: true }) summary!: string | null;
  @Column({ type: 'jsonb', nullable: true }) changes!: unknown;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt!: Date;
}
