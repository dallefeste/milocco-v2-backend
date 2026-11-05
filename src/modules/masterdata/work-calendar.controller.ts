import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ListQueryDto } from '../../common/crud/list-query.dto';
import { CreateClosureDto, UpdateClosureDto, WorkCalendarDayDto, WorkCalendarWeekDto } from './masterdata.dto';
import { WorkCalendarService } from './work-calendar.service';

/** Orario di lavoro: 7 giorni della settimana (si modificano solo le ore) e chiusure straordinarie. */
@ApiTags('Anagrafiche')
@ApiBearerAuth()
@Controller('work-calendar')
export class WorkCalendarController {
  constructor(private readonly svc: WorkCalendarService) {}

  @Get() week() { return this.svc.getWeek(); }
  /** Tutta la settimana in una volta: { days: [7 giorni, da lunedì] }. */
  @Put() updateWeek(@Body() dto: WorkCalendarWeekDto) { return this.svc.updateWeek(dto.days); }

  /** Orario calcolato di un periodo (giorni lavorativi, chiusure): ?from=YYYY-MM-DD&to=YYYY-MM-DD. */
  @Get('days')
  days(@Query('from') from?: string, @Query('to') to?: string) {
    const start = from || this.svc.today();
    return this.svc.getDays(start, to || start);
  }

  @Get('closures') closures(@Query() q: ListQueryDto) { return this.svc.listClosures(q); }
  @Get('closures/:id') closure(@Param('id', ParseIntPipe) id: number) { return this.svc.getClosure(id); }
  @Post('closures') createClosure(@Body() dto: CreateClosureDto) { return this.svc.createClosure(dto); }
  @Patch('closures/:id') updateClosure(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateClosureDto) { return this.svc.updateClosure(id, dto); }
  @Delete('closures/:id') removeClosure(@Param('id', ParseIntPipe) id: number) { return this.svc.removeClosure(id); }

  @Patch(':weekday') updateDay(@Param('weekday', ParseIntPipe) weekday: number, @Body() dto: WorkCalendarDayDto) { return this.svc.updateDay(weekday, dto); }
}
