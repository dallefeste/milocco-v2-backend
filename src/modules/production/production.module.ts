import { Module } from '@nestjs/common';
import { ProductionStripPricesInterceptor } from './common/production-db';
import { CutController } from './cut/cut.controller';
import { CutService } from './cut/cut.service';
import { ProductionOrdersController } from './orders/production-orders.controller';
import { ProductionOrdersService } from './orders/production-orders.service';
import { ScheduleController, ScheduleItemsController } from './planning/schedule.controller';
import { ScheduleItemsService } from './planning/schedule-items.service';
import { SchedulePlanService } from './planning/schedule-plan.service';
import { ProductionCountersService } from './production-counters.service';
import { ExtraActivityLogsService, InspectionsService, WorkPhasesService } from './shop/shop-records.service';
import { ExtraActivityLogsController, InspectionsController, ShopStatusController, WorkPhasesController } from './shop/shop.controller';
import { ShopStatusService } from './shop/shop-status.service';

/**
 * Modulo production: ordini di produzione, pianificazione per macchina, taglio barre, consultazione e
 * correzione delle registrazioni di reparto (vedi docs/architettura.md).
 *
 * Servizi esportati per le altre aree:
 * - ProductionCountersService: contatori `lateOrders`, `cutToApprove`, `openPhases` (cruscotto e badge);
 * - ProductionOrdersService.createOrder(dto, em): creazione ordine dentro una transazione esterna;
 * - ScheduleItemsService, SchedulePlanService (piano macchine), CutService, ShopStatusService.
 */
@Module({
  controllers: [
    ProductionOrdersController,
    ScheduleItemsController,
    ScheduleController,
    CutController,
    WorkPhasesController,
    InspectionsController,
    ExtraActivityLogsController,
    ShopStatusController,
  ],
  providers: [
    ProductionStripPricesInterceptor,
    ProductionOrdersService,
    ScheduleItemsService,
    SchedulePlanService,
    CutService,
    WorkPhasesService,
    InspectionsService,
    ExtraActivityLogsService,
    ShopStatusService,
    ProductionCountersService,
  ],
  exports: [
    ProductionCountersService,
    ProductionOrdersService,
    ScheduleItemsService,
    SchedulePlanService,
    CutService,
    WorkPhasesService,
    ShopStatusService,
  ],
})
export class ProductionModule {}
