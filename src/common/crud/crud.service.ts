import { NotFoundException } from '@nestjs/common';
import { Brackets, DeepPartial, ObjectLiteral, Repository, SelectQueryBuilder } from 'typeorm';
import { ListQueryDto, Paginated } from './list-query.dto';
import { currentUser } from '../context/request-context';

export interface CrudOptions {
  /** Etichetta italiana dell'oggetto, usata nei messaggi di errore (es. "Cliente"). */
  label: string;
  /** Relazioni da caricare (es. ['customer', 'drawing.parts']). */
  relations?: string[];
  /** Campi su cui cerca la ricerca libera, anche di relazioni caricate (es. 'customer.name'). */
  searchFields?: string[];
  /** Campi ordinabili e filtrabili ammessi; se vuoto sono ammesse le colonne della tabella. */
  sortable?: string[];
  filterable?: string[];
  defaultSort?: { field: string; order: 'asc' | 'desc' };
}

/**
 * Servizio generico per liste paginate, dettaglio, creazione, modifica ed eliminazione logica.
 * I moduli lo estendono e aggiungono le proprie regole di dominio.
 */
export class CrudService<T extends ObjectLiteral & { id: number }> {
  protected readonly alias = 'e';

  constructor(
    protected readonly repo: Repository<T>,
    protected readonly options: CrudOptions,
  ) {}

  /** Punto di estensione: aggiunge join o condizioni alla query della lista. */
  protected customizeList(_qb: SelectQueryBuilder<T>, _query: ListQueryDto): void {}

  protected baseQuery(withDeleted = false): SelectQueryBuilder<T> {
    const qb = this.repo.createQueryBuilder(this.alias);
    for (const rel of this.options.relations ?? []) {
      const parts = rel.split('.');
      let parent = this.alias;
      let path = '';
      for (const part of parts) {
        path = path ? `${path}_${part}` : part;
        const joinAlias = path;
        if (!qb.expressionMap.joinAttributes.some((j) => j.alias.name === joinAlias)) {
          qb.leftJoinAndSelect(`${parent}.${part}`, joinAlias);
        }
        parent = joinAlias;
      }
    }
    if (withDeleted) qb.withDeleted();
    return qb;
  }

  /** Converte 'customer.name' nell'alias di join usato da baseQuery ('customer.name' → 'customer.name'). */
  protected columnRef(field: string): string {
    const parts = field.split('.');
    if (parts.length === 1) return `${this.alias}.${field}`;
    const col = parts.pop() as string;
    return `${parts.join('_')}.${col}`;
  }

  private isAllowed(field: string, list?: string[]): boolean {
    if (!/^[a-zA-Z0-9_.]+$/.test(field)) return false;
    if (list && list.length > 0) return list.includes(field);
    if (field.includes('.')) return false;
    return this.repo.metadata.columns.some((c) => c.propertyName === field);
  }

  async list(query: ListQueryDto): Promise<Paginated<T>> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 25;
    const qb = this.baseQuery(query.withDeleted);

    if (query.search && this.options.searchFields?.length) {
      const term = `%${query.search.trim()}%`;
      qb.andWhere(
        new Brackets((w) => {
          for (const f of this.options.searchFields!) {
            w.orWhere(`CAST(${this.columnRef(f)} AS text) ILIKE :term`, { term });
          }
        }),
      );
    }

    for (const [field, raw] of Object.entries(query.filter ?? {})) {
      if (!this.isAllowed(field, this.options.filterable)) continue;
      const param = `f_${field.replace(/\./g, '_')}`;
      const ref = this.columnRef(field);
      if (raw === 'null') qb.andWhere(`${ref} IS NULL`);
      else if (raw === '!null') qb.andWhere(`${ref} IS NOT NULL`);
      else if (raw.includes(',')) qb.andWhere(`${ref} IN (:...${param})`, { [param]: raw.split(',') });
      else qb.andWhere(`${ref} = :${param}`, { [param]: raw });
    }

    this.customizeList(qb, query);

    const sortField = query.sort && this.isAllowed(query.sort, this.options.sortable) ? query.sort : undefined;
    if (sortField) {
      qb.orderBy(this.columnRef(sortField), (query.order ?? 'asc').toUpperCase() as 'ASC' | 'DESC', 'NULLS LAST');
    } else if (this.options.defaultSort) {
      qb.orderBy(
        this.columnRef(this.options.defaultSort.field),
        this.options.defaultSort.order.toUpperCase() as 'ASC' | 'DESC',
      );
    } else {
      qb.orderBy(`${this.alias}.id`, 'DESC');
    }
    qb.addOrderBy(`${this.alias}.id`, 'DESC');

    const [items, total] = await qb
      .skip((page - 1) * pageSize)
      .take(pageSize)
      .getManyAndCount();
    return { items, total, page, pageSize };
  }

  async findOne(id: number, withDeleted = false): Promise<T> {
    const entity = await this.baseQuery(withDeleted).andWhere(`${this.alias}.id = :id`, { id }).getOne();
    if (!entity) throw new NotFoundException(`${this.options.label} non trovato (id ${id})`);
    return entity;
  }

  async create(data: DeepPartial<T>): Promise<T> {
    const saved = await this.repo.save(this.repo.create(data));
    await this.audit('CREATE', saved.id, data);
    return this.findOne(saved.id);
  }

  async update(id: number, data: DeepPartial<T>): Promise<T> {
    const existing = await this.findOne(id);
    await this.repo.save(this.repo.merge(existing, data));
    await this.audit('UPDATE', id, data);
    return this.findOne(id);
  }

  async remove(id: number): Promise<void> {
    await this.findOne(id);
    await this.repo.softDelete(id);
    await this.audit('DELETE', id);
  }

  async restore(id: number): Promise<T> {
    await this.repo.restore(id);
    await this.audit('RESTORE', id);
    return this.findOne(id);
  }

  /** Scrive una riga nel registro modifiche con l'utente della richiesta corrente. */
  protected async audit(action: 'CREATE' | 'UPDATE' | 'DELETE' | 'RESTORE' | 'ACTION', entityId: number | string, changes?: unknown, summary?: string): Promise<void> {
    await writeAudit(this.repo.manager, this.repo.metadata.tableName, action, entityId, changes, summary);
  }
}

/** Scrive nel registro modifiche (utilizzabile anche fuori dai servizi CRUD). */
export async function writeAudit(
  manager: import('typeorm').EntityManager,
  entity: string,
  action: 'CREATE' | 'UPDATE' | 'DELETE' | 'RESTORE' | 'ACTION',
  entityId: number | string,
  changes?: unknown,
  summary?: string,
): Promise<void> {
  const user = currentUser();
  const safe = changes && typeof changes === 'object' ? JSON.parse(JSON.stringify(changes, (k, v) => (/password|pin/i.test(k) ? '***' : v))) : null;
  await manager.query(
    'INSERT INTO audit_log (user_id, username, entity, entity_id, action, summary, changes) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [user.userId ?? null, user.username ?? null, entity, String(entityId), action, summary ?? null, safe ? JSON.stringify(safe) : null],
  );
}
