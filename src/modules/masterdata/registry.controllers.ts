import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthUser, CurrentUser, Roles } from '../../common/auth/decorators';
import { ListQueryDto } from '../../common/crud/list-query.dto';
import { canSeePrices, ReservedPricesInterceptor } from './masterdata.common';
import {
  CreateCustomerDto, CreateDepartmentDto, CreateExtraActivityDto, CreateFinishDto, CreateMachineTypeDto, CreateMaterialDto,
  CreateStopReasonDto, CreateSupplierDto, CreateTreatmentDto, UpdateCustomerDto, UpdateDepartmentDto, UpdateExtraActivityDto,
  UpdateFinishDto, UpdateMachineTypeDto, UpdateMaterialDto, UpdateStopReasonDto, UpdateSupplierDto, UpdateTreatmentDto,
} from './masterdata.dto';
import {
  CustomersService, DepartmentsService, ExtraActivitiesService, FinishesService, MachineTypesService, MaterialsService,
  StopReasonsService, SuppliersService, TreatmentsService,
} from './registry.services';

/** Clienti: l'ufficio li consulta, solo l'amministratore li modifica. */
@ApiTags('Anagrafiche')
@ApiBearerAuth()
@Controller('customers')
export class CustomersController {
  constructor(private readonly svc: CustomersService) {}
  @Get() list(@Query() q: ListQueryDto) { return this.svc.list(q); }
  @Get(':id') get(@Param('id', ParseIntPipe) id: number) { return this.svc.findOne(id); }
  @Roles('ADMIN') @Post() create(@Body() dto: CreateCustomerDto) { return this.svc.create(dto); }
  @Roles('ADMIN') @Patch(':id') update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateCustomerDto) { return this.svc.update(id, dto); }
  @Roles('ADMIN') @Delete(':id') remove(@Param('id', ParseIntPipe) id: number) { return this.svc.remove(id); }
}

/** Fornitori: l'ufficio li consulta, solo l'amministratore li modifica. */
@ApiTags('Anagrafiche')
@ApiBearerAuth()
@Controller('suppliers')
export class SuppliersController {
  constructor(private readonly svc: SuppliersService) {}
  @Get() list(@Query() q: ListQueryDto) { return this.svc.list(q); }
  @Get(':id') get(@Param('id', ParseIntPipe) id: number) { return this.svc.findOne(id); }
  @Roles('ADMIN') @Post() create(@Body() dto: CreateSupplierDto) { return this.svc.create(dto); }
  @Roles('ADMIN') @Patch(':id') update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateSupplierDto) { return this.svc.update(id, dto); }
  @Roles('ADMIN') @Delete(':id') remove(@Param('id', ParseIntPipe) id: number) { return this.svc.remove(id); }
}

@ApiTags('Anagrafiche')
@ApiBearerAuth()
@Controller('departments')
export class DepartmentsController {
  constructor(private readonly svc: DepartmentsService) {}
  @Get() list(@Query() q: ListQueryDto) { return this.svc.list(q); }
  @Get(':id') get(@Param('id', ParseIntPipe) id: number) { return this.svc.findOne(id); }
  @Post() create(@Body() dto: CreateDepartmentDto) { return this.svc.create(dto); }
  @Patch(':id') update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateDepartmentDto) { return this.svc.update(id, dto); }
  @Delete(':id') remove(@Param('id', ParseIntPipe) id: number) { return this.svc.remove(id); }
}

@ApiTags('Anagrafiche')
@ApiBearerAuth()
@Controller('machine-types')
export class MachineTypesController {
  constructor(private readonly svc: MachineTypesService) {}
  @Get() list(@Query() q: ListQueryDto) { return this.svc.list(q); }
  @Get(':id') get(@Param('id', ParseIntPipe) id: number) { return this.svc.findOne(id); }
  @Post() create(@Body() dto: CreateMachineTypeDto) { return this.svc.create(dto); }
  @Patch(':id') update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateMachineTypeDto) { return this.svc.update(id, dto); }
  @Delete(':id') remove(@Param('id', ParseIntPipe) id: number) { return this.svc.remove(id); }
}

/** Materiali: il prezzo al kg è visibile e modificabile solo dall'amministratore. */
@ApiTags('Anagrafiche')
@ApiBearerAuth()
@UseInterceptors(ReservedPricesInterceptor)
@Controller('materials')
export class MaterialsController {
  constructor(private readonly svc: MaterialsService) {}
  @Get() list(@Query() q: ListQueryDto) { return this.svc.list(q); }
  @Get(':id') get(@Param('id', ParseIntPipe) id: number) { return this.svc.findOne(id); }
  @Post() create(@CurrentUser() u: AuthUser, @Body() dto: CreateMaterialDto) {
    if (!canSeePrices(u.role)) delete dto.pricePerKg;
    return this.svc.create(dto);
  }
  @Patch(':id') update(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: UpdateMaterialDto) {
    if (!canSeePrices(u.role)) delete dto.pricePerKg;
    return this.svc.update(id, dto);
  }
  @Delete(':id') remove(@Param('id', ParseIntPipe) id: number) { return this.svc.remove(id); }
}

/** Finiture: codice fisso dopo la creazione; eliminazione solo se non usata. */
@ApiTags('Anagrafiche')
@ApiBearerAuth()
@Controller('finishes')
export class FinishesController {
  constructor(private readonly svc: FinishesService) {}
  @Get() list(@Query() q: ListQueryDto) { return this.svc.list(q); }
  @Get(':id') get(@Param('id', ParseIntPipe) id: number) { return this.svc.findOne(id); }
  @Post() create(@Body() dto: CreateFinishDto) { return this.svc.create(dto); }
  @Patch(':id') update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateFinishDto) { return this.svc.update(id, dto); }
  @Delete(':id') remove(@Param('id', ParseIntPipe) id: number) { return this.svc.remove(id); }
}

@ApiTags('Anagrafiche')
@ApiBearerAuth()
@Controller('treatments')
export class TreatmentsController {
  constructor(private readonly svc: TreatmentsService) {}
  @Get() list(@Query() q: ListQueryDto) { return this.svc.list(q); }
  @Get(':id') get(@Param('id', ParseIntPipe) id: number) { return this.svc.findOne(id); }
  @Post() create(@Body() dto: CreateTreatmentDto) { return this.svc.create(dto); }
  @Patch(':id') update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateTreatmentDto) { return this.svc.update(id, dto); }
  @Delete(':id') remove(@Param('id', ParseIntPipe) id: number) { return this.svc.remove(id); }
}

@ApiTags('Anagrafiche')
@ApiBearerAuth()
@Controller('stop-reasons')
export class StopReasonsController {
  constructor(private readonly svc: StopReasonsService) {}
  @Get() list(@Query() q: ListQueryDto) { return this.svc.list(q); }
  @Get(':id') get(@Param('id', ParseIntPipe) id: number) { return this.svc.findOne(id); }
  @Post() create(@Body() dto: CreateStopReasonDto) { return this.svc.create(dto); }
  @Patch(':id') update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateStopReasonDto) { return this.svc.update(id, dto); }
  @Delete(':id') remove(@Param('id', ParseIntPipe) id: number) { return this.svc.remove(id); }
}

@ApiTags('Anagrafiche')
@ApiBearerAuth()
@Controller('extra-activities')
export class ExtraActivitiesController {
  constructor(private readonly svc: ExtraActivitiesService) {}
  @Get() list(@Query() q: ListQueryDto) { return this.svc.list(q); }
  @Get(':id') get(@Param('id', ParseIntPipe) id: number) { return this.svc.findOne(id); }
  @Post() create(@Body() dto: CreateExtraActivityDto) { return this.svc.create(dto); }
  @Patch(':id') update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateExtraActivityDto) { return this.svc.update(id, dto); }
  @Delete(':id') remove(@Param('id', ParseIntPipe) id: number) { return this.svc.remove(id); }
}
