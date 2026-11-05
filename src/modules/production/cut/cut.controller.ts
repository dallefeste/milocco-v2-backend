import type { Request } from 'express';
import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Query, Req, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsInt, Min } from 'class-validator';
import { ListQueryDto } from '../../../common/crud/list-query.dto';
import { ProductionStripPricesInterceptor, withRawFilters } from '../common/production-db';
import { CutService } from './cut.service';

export class CutIdsDto {
  @IsArray() @ArrayMinSize(1, { message: 'Selezionare almeno un particolare' }) @Type(() => Number) @IsInt({ each: true })
  ids!: number[];
}

export class CutMoveDto {
  @Type(() => Number) @IsInt() @Min(1, { message: 'Posizione non valida' }) position!: number;
}

@ApiTags('Taglio barre')
@ApiBearerAuth()
@UseInterceptors(ProductionStripPricesInterceptor)
@Controller('cut')
export class CutController {
  constructor(private readonly cut: CutService) {}

  /** Particolari da approvare per il taglio (filtri: filter[customerId], filter[productionOrderId]). */
  @Get('approval') approval(@Query() q: ListQueryDto, @Req() req: Request) { return this.cut.approvalList(withRawFilters(q, req.query), 'NONE'); }
  /** Particolari esclusi dal taglio ("ignorati"), ripristinabili. */
  @Get('approval/ignored') ignored(@Query() q: ListQueryDto, @Req() req: Request) { return this.cut.approvalList(withRawFilters(q, req.query), 'IGNORED'); }
  @Post('approval/approve') approve(@Body() dto: CutIdsDto) { return this.cut.approve(dto.ids); }
  @Post('approval/ignore') ignore(@Body() dto: CutIdsDto) { return this.cut.setIgnored(dto.ids, true); }
  @Post('approval/unignore') unignore(@Body() dto: CutIdsDto) { return this.cut.setIgnored(dto.ids, false); }

  @Get('queue') queue() { return this.cut.queue(); }
  @Post('queue/:id/move') move(@Param('id', ParseIntPipe) id: number, @Body() dto: CutMoveDto) { return this.cut.move(id, dto.position); }
  @Delete('queue/:id') remove(@Param('id', ParseIntPipe) id: number) { return this.cut.remove(id); }
}
