import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query, Req, UseInterceptors } from '@nestjs/common';
import type { Request } from 'express';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../common/auth/decorators';
import { ListQueryDto } from '../../common/crud/list-query.dto';
import { DrawingsService } from './drawings.service';
import { PartHistoryService } from './part-history.service';
import { PartsService } from './parts.service';
import { withRawFilters } from './list-filters';
import { StripPricesInterceptor } from './strip-prices.interceptor';
import { CreateDrawingDto, CreatePartDto, UpdateDrawingDto, UpdatePartDto, WeightPreviewDto } from './technical.dto';

@ApiTags('Disegni')
@ApiBearerAuth()
@UseInterceptors(StripPricesInterceptor)
@Controller('drawings')
export class DrawingsController {
  constructor(private readonly drawings: DrawingsService) {}

  @Get()
  @ApiOperation({ summary: 'Lista disegni. Filtri: filter[completeness]=TO_COMPLETE|COMPLETE, filter[customerOrderId], filter[partId]' })
  list(@Query() q: ListQueryDto, @Req() req: Request) { return this.drawings.list(withRawFilters(q, req.query)); }

  @Get('incomplete')
  @ApiOperation({ summary: 'Disegni da compilare (stessi filtri della lista, es. filter[customerOrderId])' })
  incomplete(@Query() q: ListQueryDto, @Req() req: Request) { return this.drawings.listIncomplete(withRawFilters(q, req.query)); }

  @Get(':id') get(@Param('id', ParseIntPipe) id: number) { return this.drawings.detail(id); }
  @Post() create(@Body() dto: CreateDrawingDto) { return this.drawings.createDrawing(dto); }
  @Patch(':id') update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateDrawingDto) { return this.drawings.updateDrawing(id, dto); }
  @Delete(':id') remove(@Param('id', ParseIntPipe) id: number) { return this.drawings.remove(id); }
}

@ApiTags('Particolari')
@ApiBearerAuth()
@UseInterceptors(StripPricesInterceptor)
@Controller('parts')
export class PartsController {
  constructor(
    private readonly parts: PartsService,
    private readonly history: PartHistoryService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Lista particolari. Filtri: filter[drawingId], filter[completeness], filter[materialId], filter[barCut], filter[barTypeId], filter[supplierId]' })
  list(@Query() q: ListQueryDto, @Req() req: Request) { return this.parts.list(withRawFilters(q, req.query)); }

  @Get('weight-shapes')
  @ApiOperation({ summary: 'Forme del calcolatore peso con le misure richieste' })
  shapes() { return this.parts.shapes(); }

  @Post('weight-preview')
  @ApiOperation({ summary: 'Calcola peso (kg) e testo dimensioni da forma, misure in mm e materiale' })
  weightPreview(@Body() dto: WeightPreviewDto) { return this.parts.weightPreview(dto); }

  @Get(':id') get(@Param('id', ParseIntPipe) id: number) { return this.parts.detail(id); }

  @Get(':id/time-history')
  @ApiOperation({ summary: 'Storico tempi reali per ordine di produzione completato e tipologia macchina' })
  timeHistory(@Param('id', ParseIntPipe) id: number) { return this.history.timeHistory(id); }

  @Roles('ADMIN')
  @Get(':id/quote-history')
  @ApiOperation({ summary: 'Storico costi preventivati del particolare (solo amministratore)' })
  quoteHistory(@Param('id', ParseIntPipe) id: number) { return this.history.quoteHistory(id); }

  @Post() create(@Body() dto: CreatePartDto) { return this.parts.createPart(dto); }
  @Patch(':id') update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdatePartDto) { return this.parts.updatePart(id, dto); }
  @Delete(':id') remove(@Param('id', ParseIntPipe) id: number) { return this.parts.remove(id); }
}
