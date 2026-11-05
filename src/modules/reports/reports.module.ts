import { Module } from '@nestjs/common';
import { ProductionModule } from '../production/production.module';
import { SalesModule } from '../sales/sales.module';
import { TechnicalModule } from '../technical/technical.module';
import { CustomerOrderReportService } from './customer-order-report.service';
import { DailyService } from './daily.service';
import { DashboardService } from './dashboard.service';
import { OperatorReportService } from './operator-report.service';
import { PhaseDataService } from './phase-data.service';
import { PlannedVsActualService } from './planned-vs-actual.service';
import { ProductionOrderTimesService } from './production-order-times.service';
import { DashboardController, ReportsController, SearchController } from './reports.controller';
import { SearchService } from './search.service';

/**
 * Report, cruscotto della home e ricerca globale. Legge i dati direttamente dal database; unica
 * dipendenza: DrawingsService (area tecnica) per il contatore dei disegni da compilare.
 * Tutti i tempi passano dalla regola unica di time-calc.ts.
 */
@Module({
  imports: [TechnicalModule, SalesModule, ProductionModule],
  controllers: [ReportsController, DashboardController, SearchController],
  providers: [
    PhaseDataService,
    ProductionOrderTimesService,
    DailyService,
    OperatorReportService,
    CustomerOrderReportService,
    PlannedVsActualService,
    DashboardService,
    SearchService,
  ],
  exports: [PhaseDataService],
})
export class ReportsModule {}
