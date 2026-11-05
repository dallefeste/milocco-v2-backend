import { Controller, Get, Header, Param, ParseIntPipe, Query, StreamableFile } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Matches, Min } from 'class-validator';
import { AuthUser, CurrentUser, Roles } from '../../common/auth/decorators';
import { CustomerOrderReportService } from './customer-order-report.service';
import { DailyService } from './daily.service';
import { DashboardService } from './dashboard.service';
import { OperatorReportService } from './operator-report.service';
import { PlannedVsActualService } from './planned-vs-actual.service';
import { ProductionOrderTimesService } from './production-order-times.service';
import { SearchService } from './search.service';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MSG = 'Usa il formato data AAAA-MM-GG.';

export class DayQueryDto {
  @ApiPropertyOptional({ description: 'Giorno (AAAA-MM-GG), predefinito oggi' })
  @IsOptional() @Matches(DAY, { message: DAY_MSG }) day?: string;
}

export class RangeQueryDto {
  @ApiPropertyOptional({ description: 'Data di inizio (AAAA-MM-GG), predefinita: 7 giorni prima della fine' })
  @IsOptional() @Matches(DAY, { message: DAY_MSG }) from?: string;
  @ApiPropertyOptional({ description: 'Data di fine (AAAA-MM-GG), predefinita: oggi' })
  @IsOptional() @Matches(DAY, { message: DAY_MSG }) to?: string;
}

export class PlannedQueryDto extends RangeQueryDto {
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1) machineId?: number;
}

export class OverviewQueryDto {
  @ApiPropertyOptional({ description: 'Giorno di riferimento (AAAA-MM-GG), predefinito oggi' })
  @IsOptional() @Matches(DAY, { message: DAY_MSG }) at?: string;
}

export class SearchQueryDto {
  @ApiProperty() @IsOptional() @IsString() q?: string;
}

@ApiTags('Report')
@ApiBearerAuth()
@Controller('reports')
export class ReportsController {
  constructor(
    private readonly times: ProductionOrderTimesService,
    private readonly daily: DailyService,
    private readonly operator: OperatorReportService,
    private readonly customerOrder: CustomerOrderReportService,
    private readonly planned: PlannedVsActualService,
  ) {}

  @Get('production-orders/:id/times.pdf')
  @ApiOperation({ summary: 'PDF tempi di produzione di un ordine di produzione' })
  @Header('Content-Type', 'application/pdf')
  async timesPdf(@Param('id', ParseIntPipe) id: number): Promise<StreamableFile> {
    const pdf = await this.times.pdf(id);
    return new StreamableFile(pdf, { type: 'application/pdf', disposition: `inline; filename="tempi-ordine-${id}.pdf"`, length: pdf.length });
  }

  @Get('production-orders/:id/times')
  @ApiOperation({ summary: 'Dati della stampa tempi di produzione (stessi numeri del PDF)' })
  timesData(@Param('id', ParseIntPipe) id: number) {
    return this.times.data(id);
  }

  @Get('daily/operators')
  @ApiOperation({ summary: 'Riassunto giornaliero per operatore (diagramma temporale)' })
  dailyOperators(@Query() q: DayQueryDto) {
    return this.daily.build('operators', q.day);
  }

  @Get('daily/machines')
  @ApiOperation({ summary: 'Riassunto giornaliero per macchina (diagramma temporale)' })
  dailyMachines(@Query() q: DayQueryDto) {
    return this.daily.build('machines', q.day);
  }

  @Get('operators/:id')
  @ApiOperation({ summary: 'Report operatore: tempi per cliente e ordine (costi solo per amministratori)' })
  operatorReport(@Param('id', ParseIntPipe) id: number, @Query() q: RangeQueryDto, @CurrentUser() u: AuthUser) {
    return this.operator.build(id, q, { byMachine: false, withCosts: u.role === 'ADMIN' });
  }

  @Get('operators/:id/machines')
  @ApiOperation({ summary: 'Report operatore per macchina (massimo 31 giorni)' })
  operatorMachinesReport(@Param('id', ParseIntPipe) id: number, @Query() q: RangeQueryDto, @CurrentUser() u: AuthUser) {
    return this.operator.build(id, q, { byMachine: true, withCosts: u.role === 'ADMIN' });
  }

  @Get('customer-orders/:id')
  @ApiOperation({ summary: 'Ordine cliente: avanzamento e trattamenti' })
  customerOrderOverview(@Param('id', ParseIntPipe) id: number) {
    return this.customerOrder.overview(id);
  }

  @Roles('ADMIN')
  @Get('customer-orders/:id/costs')
  @ApiOperation({ summary: 'Ordine cliente: costi (solo amministratori)' })
  customerOrderCosts(@Param('id', ParseIntPipe) id: number) {
    return this.customerOrder.costs(id);
  }

  @Get('planned-vs-actual')
  @ApiOperation({ summary: 'Tempi previsti e consuntivi delle lavorazioni pianificate concluse' })
  plannedVsActual(@Query() q: PlannedQueryDto) {
    return this.planned.build(q);
  }
}

@ApiTags('Cruscotto')
@ApiBearerAuth()
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('counters')
  @ApiOperation({ summary: 'Contatori del menu (elementi da gestire)' })
  counters() {
    return this.dashboard.counters();
  }

  @Get('overview')
  @ApiOperation({ summary: 'Dati della home' })
  overview(@Query() q: OverviewQueryDto) {
    return this.dashboard.overview(q.at);
  }
}

@ApiTags('Ricerca')
@ApiBearerAuth()
@Controller('search')
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  @Get()
  @ApiOperation({ summary: 'Ricerca globale su ordini, disegni, particolari, clienti, preventivi' })
  search(@Query() q: SearchQueryDto, @CurrentUser() u: AuthUser) {
    return this.searchService.search(q.q, u.role);
  }
}
