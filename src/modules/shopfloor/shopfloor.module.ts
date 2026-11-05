import { Module } from '@nestjs/common';
import { MasterdataModule } from '../masterdata/masterdata.module';
import { UsersModule } from '../users/users.module';
import { ShopfloorActionsService } from './shopfloor-actions.service';
import { ShopfloorController } from './shopfloor.controller';
import { ShopfloorReadService } from './shopfloor-read.service';

/** Modulo shopfloor: API dell'app tablet di reparto (/shopfloor, ruolo TABLET). */
@Module({
  imports: [UsersModule, MasterdataModule],
  controllers: [ShopfloorController],
  providers: [ShopfloorActionsService, ShopfloorReadService],
  exports: [],
})
export class ShopfloorModule {}
