import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthUser, CurrentUser } from '../../common/auth/decorators';
import { ListQueryDto } from '../../common/crud/list-query.dto';
import { BarStockService } from './bar-stock.service';
import { BarTypesService } from './bar-types.service';
import { ReservedPricesInterceptor } from './masterdata.common';
import { BarLoadDto, BarMovementDto, CreateBarTypeDto, PreviewBarTypeDto, UpdateBarTypeDto } from './masterdata.dto';

/** Tipologie barre: codice calcolato da materiale, forma, finitura e dimensioni; creazione manuale con anteprima. */
@ApiTags('Barre')
@ApiBearerAuth()
@UseInterceptors(ReservedPricesInterceptor)
@Controller('bar-types')
export class BarTypesController {
  constructor(private readonly svc: BarTypesService) {}

  @Get() list(@Query() q: ListQueryDto) { return this.svc.list(q); }
  /** Anteprima del codice per il modulo di creazione. */
  @Post('preview') preview(@Body() dto: PreviewBarTypeDto) { return this.svc.preview(dto); }
  @Get(':id') get(@Param('id', ParseIntPipe) id: number) { return this.svc.findOne(id); }
  @Post() create(@Body() dto: CreateBarTypeDto) { return this.svc.createBarType(dto); }
  @Patch(':id') update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateBarTypeDto) { return this.svc.updateBarType(id, dto); }
  @Delete(':id') remove(@Param('id', ParseIntPipe) id: number) { return this.svc.remove(id); }
}

/** Magazzino barre: giacenze in metri, carico/scarico/rettifica, storico movimenti. */
@ApiTags('Barre')
@ApiBearerAuth()
@UseInterceptors(ReservedPricesInterceptor)
@Controller('bar-stock')
export class BarStockController {
  constructor(private readonly stock: BarStockService, private readonly types: BarTypesService) {}

  /** Giacenze per tipologia (una riga per tipologia, `stock` = giacenza). filter[stockState]=available|negative|empty. */
  @Get() list(@Query() q: ListQueryDto) { return this.types.list(q); }
  @Get('summary') summary() { return this.stock.summary(); }
  /** Storico movimenti: filter[barTypeId], filter[kind], filter[operatorId], filter[productionOrderId]. */
  @Get('movements') movements(@Query() q: ListQueryDto) { return this.stock.listMovements(q); }
  @Get(':barTypeId') get(@Param('barTypeId', ParseIntPipe) id: number) { return this.types.findOne(id); }

  @Post(':barTypeId/load')
  load(@CurrentUser() u: AuthUser, @Param('barTypeId', ParseIntPipe) id: number, @Body() dto: BarLoadDto) {
    return this.stock.load(id, dto.meters, { reason: dto.reason, operatorId: dto.operatorId, productionOrderId: dto.productionOrderId, userId: u.id });
  }

  @Post(':barTypeId/unload')
  unload(@CurrentUser() u: AuthUser, @Param('barTypeId', ParseIntPipe) id: number, @Body() dto: BarLoadDto) {
    return this.stock.unload(id, dto.meters, { reason: dto.reason, operatorId: dto.operatorId, productionOrderId: dto.productionOrderId, userId: u.id });
  }

  /** Rettifica: `meters` è la nuova giacenza (inventario). */
  @Post(':barTypeId/adjust')
  adjust(@CurrentUser() u: AuthUser, @Param('barTypeId', ParseIntPipe) id: number, @Body() dto: BarMovementDto) {
    return this.stock.adjust(id, dto.meters, { reason: dto.reason, operatorId: dto.operatorId, productionOrderId: dto.productionOrderId, userId: u.id });
  }
}
