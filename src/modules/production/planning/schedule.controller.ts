import type { Request } from 'express';
import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query, Req, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ListQueryDto } from '../../../common/crud/list-query.dto';
import { ProductionStripPricesInterceptor, withRawFilters } from '../common/production-db';
import {
  BulkCreateScheduleItemsDto, CreateScheduleItemDto, MoveScheduleItemDto, PeriodQueryDto, ProposalQueryDto, UpdateScheduleItemDto,
} from './schedule.dto';
import { ScheduleItemsService } from './schedule-items.service';
import { SchedulePlanService } from './schedule-plan.service';

@ApiTags('Pianificazione')
@ApiBearerAuth()
@UseInterceptors(ProductionStripPricesInterceptor)
@Controller('schedule-items')
export class ScheduleItemsController {
  constructor(private readonly items: ScheduleItemsService) {}

  /** Filtri: filter[machineId], filter[productionOrderId], filter[partId], filter[customerId], filter[status]=ACTIVE|OPEN,IN_PROGRESS,DONE. */
  @Get() list(@Query() q: ListQueryDto, @Req() req: Request) { return this.items.list(withRawFilters(q, req.query)); }
  /** Tempi proposti dal preventivo collegato all'ordine cliente o, in mancanza, dal ciclo del particolare. */
  @Get('proposal') proposal(@Query() q: ProposalQueryDto) { return this.items.proposal(q.productionOrderId, q.partId, q.machineId); }
  @Get(':id') get(@Param('id', ParseIntPipe) id: number) { return this.items.get(id); }
  @Post() create(@Body() dto: CreateScheduleItemDto) { return this.items.createItem(dto); }
  @Post('bulk') bulk(@Body() dto: BulkCreateScheduleItemsDto) { return this.items.createBulk(dto); }
  @Post(':id/move') move(@Param('id', ParseIntPipe) id: number, @Body() dto: MoveScheduleItemDto) { return this.items.move(id, dto.machineId, dto.position); }
  @Patch(':id') update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateScheduleItemDto) { return this.items.updateItem(id, dto); }
  @Delete(':id') remove(@Param('id', ParseIntPipe) id: number) { return this.items.removeItem(id); }
}

@ApiTags('Pianificazione')
@ApiBearerAuth()
@Controller('schedule')
export class ScheduleController {
  constructor(private readonly plan: SchedulePlanService) {}

  /** Code di tutte le macchine pianificabili con inizio e fine previsti. */
  @Get('plan') get() { return this.plan.plan(); }
  /** Confronto pianificato / consuntivo delle lavorazioni concluse (date AAAA-MM-GG, predefinito ultimi 7 giorni). */
  @Get('planned-vs-actual') plannedVsActual(@Query() q: PeriodQueryDto) { return this.plan.plannedVsActual(q.from, q.to); }
}
