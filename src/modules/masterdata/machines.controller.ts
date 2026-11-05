import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../common/auth/decorators';
import { ListQueryDto } from '../../common/crud/list-query.dto';
import { ReservedPricesInterceptor } from './masterdata.common';
import { CreateMachineDto, CustomerRateDto, UpdateCustomerRateDto, UpdateMachineDto } from './masterdata.dto';
import { MachinesService } from './machines.service';

/** Macchine: l'ufficio le consulta senza prezzi; modifiche e tariffe per cliente solo all'amministratore. */
@ApiTags('Anagrafiche')
@ApiBearerAuth()
@UseInterceptors(ReservedPricesInterceptor)
@Controller('machines')
export class MachinesController {
  constructor(private readonly svc: MachinesService) {}
  @Get() list(@Query() q: ListQueryDto) { return this.svc.list(q); }
  @Get(':id') get(@Param('id', ParseIntPipe) id: number) { return this.svc.findOne(id); }
  @Roles('ADMIN') @Post() create(@Body() dto: CreateMachineDto) { return this.svc.create(dto); }
  @Roles('ADMIN') @Patch(':id') update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateMachineDto) { return this.svc.update(id, dto); }
  @Roles('ADMIN') @Delete(':id') remove(@Param('id', ParseIntPipe) id: number) { return this.svc.remove(id); }

  @Roles('ADMIN') @Get(':id/customer-rates')
  rates(@Param('id', ParseIntPipe) id: number) { return this.svc.listRates(id); }

  @Roles('ADMIN') @Post(':id/customer-rates')
  addRate(@Param('id', ParseIntPipe) id: number, @Body() dto: CustomerRateDto) { return this.svc.addRate(id, dto); }

  @Roles('ADMIN') @Patch(':id/customer-rates/:rateId')
  updateRate(@Param('id', ParseIntPipe) id: number, @Param('rateId', ParseIntPipe) rateId: number, @Body() dto: UpdateCustomerRateDto) {
    return this.svc.updateRate(id, rateId, dto);
  }

  @Roles('ADMIN') @Delete(':id/customer-rates/:rateId')
  removeRate(@Param('id', ParseIntPipe) id: number, @Param('rateId', ParseIntPipe) rateId: number) { return this.svc.removeRate(id, rateId); }
}
