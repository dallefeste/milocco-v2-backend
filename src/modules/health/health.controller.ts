import { Controller, Get } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Public } from '../../common/auth/decorators';

@Controller('health')
export class HealthController {
  constructor(private readonly ds: DataSource) {}

  @Public()
  @Get()
  async check() {
    await this.ds.query('SELECT 1');
    return { status: 'ok', time: new Date().toISOString() };
  }
}
