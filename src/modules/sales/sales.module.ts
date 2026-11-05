import { Module } from '@nestjs/common';
import { SupportModule } from '../support/support.module';
import { CustomerOrderConfirmService } from './customer-order-confirm.service';
import { CustomerOrdersController } from './customer-orders.controller';
import { CustomerOrdersService } from './customer-orders.service';
import { QuoteExcelService } from './quote-excel.service';
import { QuotesController } from './quotes.controller';
import { QuotesService } from './quotes.service';
import { SalesCountersService } from './sales-counters.service';

/**
 * Area commerciale: preventivi (con import/export Excel), ordini cliente (inseriti dall'ufficio), conferma in
 * produzione. `SalesCountersService` è esportato per i contatori della dashboard.
 */
@Module({
  imports: [SupportModule],
  controllers: [QuotesController, CustomerOrdersController],
  providers: [QuotesService, QuoteExcelService, CustomerOrdersService, CustomerOrderConfirmService, SalesCountersService],
  exports: [SalesCountersService, QuotesService, CustomerOrdersService],
})
export class SalesModule {}
