import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Setting } from './setting.entity';

@Injectable()
export class SettingsService {
  constructor(@InjectRepository(Setting) private readonly repo: Repository<Setting>) {}

  list(): Promise<Setting[]> {
    return this.repo.find({ order: { key: 'ASC' } });
  }

  async get<T = unknown>(key: string, fallback: T): Promise<T> {
    const row = await this.repo.findOne({ where: { key } });
    return (row?.value as T) ?? fallback;
  }

  async set(key: string, value: unknown): Promise<Setting> {
    const row = await this.repo.findOne({ where: { key } });
    if (!row) throw new NotFoundException(`Impostazione ${key} non trovata`);
    row.value = value;
    return this.repo.save(row);
  }
}
