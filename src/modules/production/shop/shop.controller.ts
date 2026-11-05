import type { Request } from 'express';
import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Query, Req, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ProductionStripPricesInterceptor, withRawFilters } from '../common/production-db';
import { CloseWorkPhaseDto, CorrectExtraActivityLogDto, CorrectInspectionDto, CorrectWorkPhaseDto, CorrectWorkStopDto, ShopListQueryDto } from './shop.dto';
import { ExtraActivityLogsService, InspectionsService, WorkPhasesService, shopQuery } from './shop-records.service';
import { ShopStatusService } from './shop-status.service';

@ApiTags('Reparto')
@ApiBearerAuth()
@UseInterceptors(ProductionStripPricesInterceptor)
@Controller('work-phases')
export class WorkPhasesController {
  constructor(private readonly phases: WorkPhasesService) {}

  /** Filtri: filter[machineId|operatorId|productionOrderId|partId|status], ?productionOrderId=, ?from=&to= (inizio attrezzaggio). */
  @Get() list(@Query() q: ShopListQueryDto, @Req() req: Request) { return this.phases.list(shopQuery(withRawFilters(q, req.query))); }
  @Get(':id') get(@Param('id', ParseIntPipe) id: number) { return this.phases.detail(id); }
  /** Correzione d'ufficio di orari, pezzi e stato (registrata nel registro modifiche). */
  @Patch(':id') correct(@Param('id', ParseIntPipe) id: number, @Body() dto: CorrectWorkPhaseDto) { return this.phases.correct(id, dto); }
  /** Chiusura d'ufficio di una fase rimasta aperta. */
  @Post(':id/close') close(@Param('id', ParseIntPipe) id: number, @Body() dto: CloseWorkPhaseDto) { return this.phases.close(id, dto); }
  @Patch(':id/stops/:stopId') correctStop(@Param('id', ParseIntPipe) id: number, @Param('stopId', ParseIntPipe) stopId: number, @Body() dto: CorrectWorkStopDto) {
    return this.phases.correctStop(id, stopId, dto);
  }
}

@ApiTags('Reparto')
@ApiBearerAuth()
@UseInterceptors(ProductionStripPricesInterceptor)
@Controller('inspections')
export class InspectionsController {
  constructor(private readonly inspections: InspectionsService) {}

  /** Filtri: filter[productionOrderId|operatorId|machineId], filter[open]=true|false, ?from=&to=. */
  @Get() list(@Query() q: ShopListQueryDto, @Req() req: Request) { return this.inspections.list(shopQuery(withRawFilters(q, req.query))); }
  @Get(':id') get(@Param('id', ParseIntPipe) id: number) { return this.inspections.findOne(id, true); }
  @Patch(':id') correct(@Param('id', ParseIntPipe) id: number, @Body() dto: CorrectInspectionDto) { return this.inspections.correct(id, dto); }
}

@ApiTags('Reparto')
@ApiBearerAuth()
@UseInterceptors(ProductionStripPricesInterceptor)
@Controller('extra-activity-logs')
export class ExtraActivityLogsController {
  constructor(private readonly logs: ExtraActivityLogsService) {}

  /** Filtri: filter[operatorId|extraActivityId|machineId], filter[open]=true|false, ?from=&to=. */
  @Get() list(@Query() q: ShopListQueryDto, @Req() req: Request) { return this.logs.list(shopQuery(withRawFilters(q, req.query))); }
  @Get(':id') get(@Param('id', ParseIntPipe) id: number) { return this.logs.findOne(id, true); }
  @Patch(':id') correct(@Param('id', ParseIntPipe) id: number, @Body() dto: CorrectExtraActivityLogDto) { return this.logs.correct(id, dto); }
}

@ApiTags('Reparto')
@ApiBearerAuth()
@UseInterceptors(ProductionStripPricesInterceptor)
@Controller('shop-status')
export class ShopStatusController {
  constructor(private readonly shop: ShopStatusService) {}

  /** Cosa succede adesso su ogni macchina, lavori extra e collaudi in corso. */
  @Get() get() { return this.shop.status(); }
}
