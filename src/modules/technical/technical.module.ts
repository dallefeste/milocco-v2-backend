import { Module } from '@nestjs/common';
import { DrawingsService } from './drawings.service';
import { PartHistoryService } from './part-history.service';
import { PartsService } from './parts.service';
import { DrawingsController, PartsController } from './technical.controller';

/**
 * Modulo technical: disegni (composizione, trattamenti, stato di compilazione) e particolari
 * (ciclo di lavorazione, calcolatore peso, storici tempi e preventivi). Vedi docs/architettura.md.
 * Esporta DrawingsService (es. countToComplete() per il cruscotto) e PartsService.
 */
@Module({
  imports: [],
  controllers: [DrawingsController, PartsController],
  providers: [DrawingsService, PartsService, PartHistoryService],
  exports: [DrawingsService, PartsService, PartHistoryService],
})
export class TechnicalModule {}
