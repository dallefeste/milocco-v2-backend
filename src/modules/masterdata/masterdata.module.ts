import { Module } from '@nestjs/common';
import { BarStockService } from './bar-stock.service';
import { BarTypesService } from './bar-types.service';
import { BarStockController, BarTypesController } from './bars.controller';
import { MachinesController } from './machines.controller';
import { MachinesService } from './machines.service';
import { ReservedPricesInterceptor } from './masterdata.common';
import { OperatorsController } from './operators.controller';
import { OperatorsService } from './operators.service';
import {
  CustomersController, DepartmentsController, ExtraActivitiesController, FinishesController, MachineTypesController,
  MaterialsController, StopReasonsController, SuppliersController, TreatmentsController,
} from './registry.controllers';
import {
  CustomersService, DepartmentsService, ExtraActivitiesService, FinishesService, MachineTypesService, MaterialsService,
  StopReasonsService, SuppliersService, TreatmentsService,
} from './registry.services';
import { WorkCalendarController } from './work-calendar.controller';
import { WorkCalendarService } from './work-calendar.service';

/**
 * Anagrafiche: clienti, fornitori, reparti, operatori, macchine e tipologie, materiali, finiture, trattamenti,
 * causali di fermo, lavori extra, orario di lavoro, tipologie barre e magazzino barre.
 *
 * Servizi esportati per le altre aree:
 * - `WorkCalendarService` (pianificazione): getDay/getDays/nextWorkingDay/isWorkingDay;
 * - `BarStockService` (tablet, coda di taglio): load/unload/adjust/getMeters/getMetersMap;
 * - `OperatorsService.verifyPin` (tablet), `MachinesService.rateFor` (preventivi);
 * - `ReservedPricesInterceptor` / `stripReservedPrices` (masterdata.common) per togliere i prezzi all'ufficio.
 */
@Module({
  controllers: [
    CustomersController, SuppliersController, DepartmentsController, OperatorsController, MachineTypesController,
    MachinesController, MaterialsController, FinishesController, TreatmentsController, StopReasonsController,
    ExtraActivitiesController, WorkCalendarController, BarTypesController, BarStockController,
  ],
  providers: [
    CustomersService, SuppliersService, DepartmentsService, OperatorsService, MachineTypesService, MachinesService,
    MaterialsService, FinishesService, TreatmentsService, StopReasonsService, ExtraActivitiesService,
    WorkCalendarService, BarTypesService, BarStockService, ReservedPricesInterceptor,
  ],
  exports: [
    WorkCalendarService, BarStockService, BarTypesService, OperatorsService, MachinesService, CustomersService,
    MaterialsService, ReservedPricesInterceptor,
  ],
})
export class MasterdataModule {}
