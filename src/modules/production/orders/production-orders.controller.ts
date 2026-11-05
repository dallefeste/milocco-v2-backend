import type { Request } from 'express';
import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query, Req, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ListQueryDto } from '../../../common/crud/list-query.dto';
import { ProductionStripPricesInterceptor, withRawFilters } from '../common/production-db';
import { ChangeProductionOrderStatusDto, CreateProductionOrderDto, UpdateProductionOrderDto } from './production-orders.dto';
import { ProductionOrdersService } from './production-orders.service';

@ApiTags('Ordini di produzione')
@ApiBearerAuth()
@UseInterceptors(ProductionStripPricesInterceptor)
@Controller('production-orders')
export class ProductionOrdersController {
  constructor(private readonly orders: ProductionOrdersService) {}

  /** Filtri: filter[status]=OPEN|TO_DO,IN_PROGRESS…, filter[customerId], filter[customerOrderId], filter[drawingId], filter[late]=true. */
  @Get() list(@Query() q: ListQueryDto, @Req() req: Request) { return this.orders.list(withRawFilters(q, req.query)); }
  @Get(':id') get(@Param('id', ParseIntPipe) id: number) { return this.orders.detail(id); }
  @Post() create(@Body() dto: CreateProductionOrderDto) { return this.orders.createAndLoad(dto); }
  @Patch(':id') update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateProductionOrderDto) { return this.orders.updateOrder(id, dto); }
  @Post(':id/status') status(@Param('id', ParseIntPipe) id: number, @Body() dto: ChangeProductionOrderStatusDto) { return this.orders.changeStatus(id, dto.status); }
  @Delete(':id') remove(@Param('id', ParseIntPipe) id: number) { return this.orders.removeOrder(id); }
}
