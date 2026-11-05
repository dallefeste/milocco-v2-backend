import {
  Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query, Res, StreamableFile, UploadedFile, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { AuthUser, CurrentUser, Roles } from '../../common/auth/decorators';
import { ListQueryDto } from '../../common/crud/list-query.dto';
import { QuoteExcelService } from './quote-excel.service';
import { QuotesService } from './quotes.service';
import { CreateQuoteDto, CreateQuotePartDto, UpdateQuoteDto, UpdateQuotePartDto } from './sales.dto';

/** Preventivi: solo amministratori (prezzi riservati). */
@ApiTags('Preventivi')
@ApiBearerAuth()
@Roles('ADMIN')
@Controller('quotes')
export class QuotesController {
  constructor(private readonly quotes: QuotesService, private readonly excel: QuoteExcelService) {}

  @Get() list(@Query() q: ListQueryDto) { return this.quotes.list(q); }

  /** Valori proposti per un nuovo preventivo (ricarichi, €/min CAM). */
  @Get('defaults') defaults() { return this.quotes.defaults(); }

  /**
   * Import da Excel (campo multipart `file`). Con `dryRun=true` restituisce solo l'anteprima con errori e
   * avvisi per riga; altrimenti, se il file non ha errori, crea il preventivo e salva il file.
   */
  @Post('import')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 20 * 1024 * 1024 } }))
  import(@CurrentUser() u: AuthUser, @UploadedFile() file: Express.Multer.File, @Body() body: { dryRun?: string }, @Query('dryRun') dryRunQuery?: string) {
    const dryRun = [body?.dryRun, dryRunQuery].some((v) => v === 'true' || v === '1');
    return this.excel.import(file, { dryRun, userId: u?.id });
  }

  @Get(':id') get(@Param('id', ParseIntPipe) id: number) { return this.quotes.detail(id); }
  @Post() create(@Body() dto: CreateQuoteDto) { return this.quotes.createQuote(dto); }
  @Patch(':id') update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateQuoteDto) { return this.quotes.updateQuote(id, dto); }
  @Delete(':id') remove(@Param('id', ParseIntPipe) id: number) { return this.quotes.remove(id); }

  @Get(':id/costs') costs(@Param('id', ParseIntPipe) id: number) { return this.quotes.costs(id); }

  @Get(':id/export.xlsx')
  async export(@Param('id', ParseIntPipe) id: number, @Res({ passthrough: true }) res: Response) {
    const { fileName, buffer } = await this.excel.export(id);
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    });
    return new StreamableFile(buffer);
  }

  /** Tipologie, macchine (con la tariffa per il cliente del preventivo) e trattamenti per il pannello delle fasi. */
  @Get(':id/options') options(@Param('id', ParseIntPipe) id: number) { return this.quotes.machineOptions(id); }

  /** Proposta per l'aggiunta di un particolare: fasi, macchine, tariffe, prezzi, trattamenti, avvisi. */
  @Get(':id/parts/proposal')
  proposal(@Param('id', ParseIntPipe) id: number, @Query('partId', ParseIntPipe) partId: number) { return this.quotes.proposalFor(id, partId); }

  @Get(':id/parts') parts(@Param('id', ParseIntPipe) id: number) { return this.quotes.listParts(id); }
  @Post(':id/parts') addPart(@Param('id', ParseIntPipe) id: number, @Body() dto: CreateQuotePartDto) { return this.quotes.createPart(id, dto); }
  @Patch(':id/parts/:rowId')
  updatePart(@Param('id', ParseIntPipe) id: number, @Param('rowId', ParseIntPipe) rowId: number, @Body() dto: UpdateQuotePartDto) {
    return this.quotes.updatePart(id, rowId, dto);
  }
  @Delete(':id/parts/:rowId')
  removePart(@Param('id', ParseIntPipe) id: number, @Param('rowId', ParseIntPipe) rowId: number) { return this.quotes.removePart(id, rowId); }
}
