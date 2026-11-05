import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../common/auth/decorators';
import { SettingsService } from './settings.service';

@ApiTags('Impostazioni')
@ApiBearerAuth()
@Controller('settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get() list() { return this.settings.list(); }

  @Roles('ADMIN')
  @Put(':key')
  set(@Param('key') key: string, @Body() body: { value: unknown }) {
    return this.settings.set(key, body.value);
  }
}
