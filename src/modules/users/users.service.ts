import { BadRequestException, Injectable, Logger, OnApplicationBootstrap, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcryptjs';
import { Repository } from 'typeorm';
import { CrudService } from '../../common/crud/crud.service';
import { CreateUserDto, UpdateUserDto } from './users.dto';
import { User } from './user.entity';

@Injectable()
export class UsersService extends CrudService<User> implements OnApplicationBootstrap {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    @InjectRepository(User) repo: Repository<User>,
    private readonly config: ConfigService,
  ) {
    super(repo, {
      label: 'Utente',
      searchFields: ['username', 'firstName', 'lastName', 'email'],
      defaultSort: { field: 'username', order: 'asc' },
    });
  }

  /** Al primo avvio crea l'amministratore indicato nel file .env se non ne esiste nessuno. */
  async onApplicationBootstrap(): Promise<void> {
    const admins = await this.repo.count({ where: { role: 'ADMIN' } });
    if (admins > 0) return;
    const username = this.config.get<string>('admin.username')!;
    const password = this.config.get<string>('admin.password')!;
    await this.repo.save(
      this.repo.create({
        username,
        firstName: 'Amministratore',
        lastName: '',
        role: 'ADMIN',
        enabled: true,
        mustChangePassword: true,
        passwordHash: await bcrypt.hash(password, 10),
      }),
    );
    this.logger.warn(`Creato l'utente amministratore "${username}": cambiare la password al primo accesso.`);
  }

  async createUser(dto: CreateUserDto): Promise<User> {
    const { password, ...rest } = dto;
    return this.create({ ...rest, passwordHash: await bcrypt.hash(password, 10), mustChangePassword: true });
  }

  async updateUser(id: number, dto: UpdateUserDto): Promise<User> {
    const { password, ...rest } = dto;
    const data: Partial<User> = { ...rest };
    if (password) {
      data.passwordHash = await bcrypt.hash(password, 10);
      data.mustChangePassword = true;
    }
    return this.update(id, data);
  }

  /** Verifica le credenziali; ritorna l'utente o lancia un errore generico. */
  async validateCredentials(username: string, password: string): Promise<User> {
    const user = await this.repo
      .createQueryBuilder('u')
      .addSelect('u.passwordHash')
      .where('LOWER(u.username) = LOWER(:username)', { username })
      .getOne();
    if (!user || !user.enabled || !user.passwordHash || !(await bcrypt.compare(password, user.passwordHash))) {
      throw new UnauthorizedException('Nome utente o password non corretti');
    }
    await this.repo.update(user.id, { lastLoginAt: new Date() });
    return user;
  }

  async changePassword(id: number, currentPassword: string | undefined, newPassword: string): Promise<void> {
    const user = await this.repo.createQueryBuilder('u').addSelect('u.passwordHash').where('u.id = :id', { id }).getOne();
    if (!user) throw new UnauthorizedException();
    if (!user.mustChangePassword) {
      if (!currentPassword || !user.passwordHash || !(await bcrypt.compare(currentPassword, user.passwordHash))) {
        throw new BadRequestException('La password attuale non è corretta');
      }
    }
    await this.repo.update(id, { passwordHash: await bcrypt.hash(newPassword, 10), mustChangePassword: false });
  }
}
