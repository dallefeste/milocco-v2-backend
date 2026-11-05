import { Module } from '@nestjs/common';
import { FilesService } from './files.service';
import { AuditLogController, FilesController, SupportTicketsController } from './support.controller';
import { SupportTicketsService } from './support-tickets.service';

/** Supporto: registro modifiche, segnalazioni degli utenti, file caricati. */
@Module({
  controllers: [AuditLogController, SupportTicketsController, FilesController],
  providers: [SupportTicketsService, FilesService],
  exports: [FilesService],
})
export class SupportModule {}
