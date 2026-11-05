import { Column, Entity } from 'typeorm';
import type { UserRole } from '../../shared';
import { AppBaseEntity } from '../../common/entities/base.entity';

@Entity('app_user')
export class User extends AppBaseEntity {
  @Column({ unique: true })
  username!: string;

  @Column({ select: false, nullable: true, type: 'text' })
  passwordHash!: string | null;

  @Column()
  firstName!: string;

  @Column()
  lastName!: string;

  @Column({ type: 'text', nullable: true })
  email!: string | null;

  @Column({ type: 'text' })
  role!: UserRole;

  @Column({ default: true })
  enabled!: boolean;

  /** L'utente deve impostare una nuova password al prossimo accesso. */
  @Column({ default: false })
  mustChangePassword!: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  lastLoginAt!: Date | null;
}
