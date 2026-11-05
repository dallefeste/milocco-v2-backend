import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { createReadStream, existsSync, mkdirSync, writeFileSync } from 'fs';
import { extname, resolve } from 'path';
import { Repository } from 'typeorm';
import { CrudService } from '../../common/crud/crud.service';
import { FileAttachment } from '../../entities';

/** File caricati (Excel dei preventivi, allegati). Salvati nella cartella STORAGE_DIR. */
@Injectable()
export class FilesService extends CrudService<FileAttachment> {
  constructor(@InjectRepository(FileAttachment) repo: Repository<FileAttachment>, private readonly config: ConfigService) {
    super(repo, { label: 'File', searchFields: ['originalName', 'description'], defaultSort: { field: 'createdAt', order: 'desc' } });
  }

  get dir(): string {
    const dir = resolve(process.cwd(), this.config.get<string>('storageDir') ?? './storage');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** Salva un file e registra la riga; utilizzabile anche dagli altri moduli. */
  async store(file: { originalname: string; mimetype: string; size: number; buffer: Buffer }, opts: { userId?: number; entity?: string; entityId?: number; description?: string } = {}) {
    const storedName = `${randomUUID()}${extname(file.originalname)}`;
    writeFileSync(resolve(this.dir, storedName), file.buffer);
    return this.create({
      originalName: file.originalname, storedName, mimeType: file.mimetype, sizeBytes: file.size,
      ownerUserId: opts.userId ?? null, entity: opts.entity ?? null, entityId: opts.entityId ?? null, description: opts.description ?? null,
    });
  }

  async stream(id: number) {
    const f = await this.findOne(id);
    const path = resolve(this.dir, f.storedName);
    if (!existsSync(path)) throw new NotFoundException('Il file non è più presente sul server');
    return { file: f, stream: createReadStream(path) };
  }
}
