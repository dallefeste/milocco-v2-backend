import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query, Res, StreamableFile, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import type { Response } from 'express';
import { Repository } from 'typeorm';
import { AuthUser, CurrentUser, Roles } from '../../common/auth/decorators';
import { ListQueryDto } from '../../common/crud/list-query.dto';
import { AuditLog } from '../../entities';
import { FilesService } from './files.service';
import { CreateTicketDto, UpdateTicketDto } from './support.dto';
import { SupportTicketsService } from './support-tickets.service';

@ApiTags('Registro modifiche')
@ApiBearerAuth()
@Roles('ADMIN')
@Controller('audit-log')
export class AuditLogController {
  constructor(@InjectRepository(AuditLog) private readonly repo: Repository<AuditLog>) {}

  @Get()
  async list(@Query() q: ListQueryDto) {
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 50;
    const qb = this.repo.createQueryBuilder('a').orderBy('a.createdAt', 'DESC');
    if (q.search) qb.andWhere('(a.entity ILIKE :s OR a.username ILIKE :s OR a.entityId = :raw OR a.summary ILIKE :s)', { s: `%${q.search}%`, raw: q.search });
    const f = q.filter ?? {};
    if (f.entity) qb.andWhere('a.entity = :entity', { entity: f.entity });
    if (f.action) qb.andWhere('a.action = :action', { action: f.action });
    if (f.entityId) qb.andWhere('a.entityId = :eid', { eid: f.entityId });
    if (f.userId) qb.andWhere('a.userId = :uid', { uid: f.userId });
    const [items, total] = await qb.skip((page - 1) * pageSize).take(pageSize).getManyAndCount();
    return { items: items.map((i) => ({ ...i, id: Number(i.id) })), total, page, pageSize };
  }

  @Get('entities')
  async entities() {
    const rows = await this.repo.query('SELECT DISTINCT entity FROM audit_log ORDER BY entity');
    return rows.map((r: { entity: string }) => r.entity);
  }
}

@ApiTags('Segnalazioni')
@ApiBearerAuth()
@Controller('support-tickets')
export class SupportTicketsController {
  constructor(private readonly tickets: SupportTicketsService) {}

  @Get() list(@CurrentUser() u: AuthUser, @Query() q: ListQueryDto) { return this.tickets.listFor(u, q); }
  @Get(':id') get(@Param('id', ParseIntPipe) id: number) { return this.tickets.findOne(id); }
  @Post() create(@CurrentUser() u: AuthUser, @Body() dto: CreateTicketDto) { return this.tickets.createFor(u, dto); }
  @Patch(':id') update(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: UpdateTicketDto) { return this.tickets.updateFor(u, id, dto); }
  @Roles('ADMIN') @Delete(':id') remove(@Param('id', ParseIntPipe) id: number) { return this.tickets.remove(id); }
}

@ApiTags('File')
@ApiBearerAuth()
@Controller('files')
export class FilesController {
  constructor(private readonly files: FilesService) {}

  @Get() list(@Query() q: ListQueryDto) { return this.files.list(q); }

  @Post()
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 50 * 1024 * 1024 } }))
  upload(@CurrentUser() u: AuthUser, @UploadedFile() file: Express.Multer.File, @Body() body: { entity?: string; entityId?: string; description?: string }) {
    return this.files.store(file, { userId: u.id, entity: body.entity, entityId: body.entityId ? Number(body.entityId) : undefined, description: body.description });
  }

  @Get(':id/download')
  async download(@Param('id', ParseIntPipe) id: number, @Res({ passthrough: true }) res: Response) {
    const { file, stream } = await this.files.stream(id);
    res.set({ 'Content-Type': file.mimeType ?? 'application/octet-stream', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.originalName)}` });
    return new StreamableFile(stream);
  }

  @Delete(':id') remove(@Param('id', ParseIntPipe) id: number) { return this.files.remove(id); }
}
