import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../common/auth/decorators';
import { ListQueryDto } from '../../common/crud/list-query.dto';
import { CreateUserDto, UpdateUserDto } from './users.dto';
import { UsersService } from './users.service';

@ApiTags('Utenti')
@ApiBearerAuth()
@Roles('ADMIN')
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get() list(@Query() q: ListQueryDto) { return this.users.list(q); }
  @Get(':id') get(@Param('id', ParseIntPipe) id: number) { return this.users.findOne(id); }
  @Post() create(@Body() dto: CreateUserDto) { return this.users.createUser(dto); }
  @Patch(':id') update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateUserDto) { return this.users.updateUser(id, dto); }
  @Delete(':id') remove(@Param('id', ParseIntPipe) id: number) { return this.users.remove(id); }
}
