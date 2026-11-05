import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../common/auth/decorators';
import { ListQueryDto } from '../../common/crud/list-query.dto';
import { CreateOperatorDto, SetPinDto, UpdateOperatorDto } from './masterdata.dto';
import { OperatorsService } from './operators.service';

/** Operatori di reparto: l'ufficio li consulta, solo l'amministratore li modifica. Il PIN non torna mai indietro. */
@ApiTags('Anagrafiche')
@ApiBearerAuth()
@Controller('operators')
export class OperatorsController {
  constructor(private readonly svc: OperatorsService) {}
  @Get() list(@Query() q: ListQueryDto) { return this.svc.listView(q); }
  @Get(':id') get(@Param('id', ParseIntPipe) id: number) { return this.svc.getView(id); }

  @Roles('ADMIN') @Post()
  async create(@Body() dto: CreateOperatorDto) { return OperatorsService.toView(await this.svc.create(dto)); }

  @Roles('ADMIN') @Patch(':id')
  async update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateOperatorDto) { return OperatorsService.toView(await this.svc.update(id, dto)); }

  @Roles('ADMIN') @Delete(':id') remove(@Param('id', ParseIntPipe) id: number) { return this.svc.remove(id); }

  /** Imposta o sostituisce il PIN con cui l'operatore si identifica sul tablet. */
  @Roles('ADMIN') @Put(':id/pin')
  setPin(@Param('id', ParseIntPipe) id: number, @Body() dto: SetPinDto) { return this.svc.setPin(id, dto.pin); }

  /** Toglie il PIN: sul tablet l'operatore si sceglie dall'elenco senza codice. */
  @Roles('ADMIN') @Delete(':id/pin')
  clearPin(@Param('id', ParseIntPipe) id: number) { return this.svc.clearPin(id); }
}
