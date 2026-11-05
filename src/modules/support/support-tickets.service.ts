import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuthUser } from '../../common/auth/decorators';
import { CrudService } from '../../common/crud/crud.service';
import { ListQueryDto } from '../../common/crud/list-query.dto';
import { SupportTicket } from '../../entities';
import { CreateTicketDto, UpdateTicketDto } from './support.dto';

/** Segnalazioni: ogni utente vede le proprie, l'amministratore tutte e ne gestisce lo stato. */
@Injectable()
export class SupportTicketsService extends CrudService<SupportTicket> {
  constructor(@InjectRepository(SupportTicket) repo: Repository<SupportTicket>) {
    super(repo, {
      label: 'Segnalazione',
      relations: ['user'],
      searchFields: ['code', 'subject', 'description', 'user.username'],
      filterable: ['status', 'priority', 'userId'],
      sortable: ['createdAt', 'code', 'priority', 'status', 'subject'],
      defaultSort: { field: 'createdAt', order: 'desc' },
    });
  }

  listFor(user: AuthUser, q: ListQueryDto) {
    const filter = { ...(q.filter ?? {}) };
    if (user.role !== 'ADMIN') filter.userId = String(user.id);
    return this.list({ ...q, filter });
  }

  async createFor(user: AuthUser, dto: CreateTicketDto) {
    const t = await this.create({ ...dto, userId: user.id, status: 'OPEN' });
    await this.repo.update(t.id, { code: `S${String(t.id).padStart(4, '0')}` });
    return this.findOne(t.id);
  }

  async updateFor(user: AuthUser, id: number, dto: UpdateTicketDto) {
    const t = await this.findOne(id);
    if (user.role !== 'ADMIN') {
      if (t.userId !== user.id) throw new ForbiddenException('Puoi modificare solo le tue segnalazioni');
      // Stato e risposta li gestisce l'amministratore: per gli altri utenti vengono ignorati
      const { status: _status, feedback: _feedback, ...own } = dto;
      return this.update(id, own);
    }
    return this.update(id, dto);
  }
}
