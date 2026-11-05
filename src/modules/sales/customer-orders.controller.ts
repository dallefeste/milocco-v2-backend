import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthUser, CurrentUser } from '../../common/auth/decorators';
import { ListQueryDto } from '../../common/crud/list-query.dto';
import { CustomerOrderConfirmService } from './customer-order-confirm.service';
import { CustomerOrdersService } from './customer-orders.service';
import { ConfirmCustomerOrderDto, CreateCustomerOrderDto, UpdateCustomerOrderDto } from './sales.dto';
import { SalesCountersService } from './sales-counters.service';

/**
 * Ordini cliente (amministratori e ufficio).
 * Filtri lista: filter[status]=INCOMPLETE,TO_CONFIRM,…  filter[customerId]  filter[from]/filter[to] (data ordine)
 * filter[drawingId].
 */
@ApiTags('Ordini cliente')
@ApiBearerAuth()
@Controller('customer-orders')
export class CustomerOrdersController {
  constructor(
    private readonly orders: CustomerOrdersService,
    private readonly confirmation: CustomerOrderConfirmService,
    private readonly counters: SalesCountersService,
  ) {}

  @Get() list(@Query() q: ListQueryDto) { return this.orders.list(q); }

  /** Contatori dell'area (ordini da confermare). */
  @Get('counters') count() { return this.counters.counters(); }

  @Get(':id') get(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.orders.detail(id, u?.role); }
  @Post() create(@CurrentUser() u: AuthUser, @Body() dto: CreateCustomerOrderDto) { return this.orders.create(dto, u?.role); }
  @Patch(':id')
  update(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: UpdateCustomerOrderDto) { return this.orders.update(id, dto, u?.role); }
  @Delete(':id') remove(@Param('id', ParseIntPipe) id: number) { return this.orders.remove(id); }

  /** Righe ancora da confermare con le fasi da pianificare e le macchine ammesse. */
  @Get(':id/confirmation') proposal(@Param('id', ParseIntPipe) id: number) { return this.confirmation.proposal(id); }

  /** Conferma: crea ordini di produzione e lavorazioni pianificate in un'unica transazione. */
  @Post(':id/confirmation') confirm(@Param('id', ParseIntPipe) id: number, @Body() dto: ConfirmCustomerOrderDto) { return this.confirmation.confirm(id, dto); }
}
