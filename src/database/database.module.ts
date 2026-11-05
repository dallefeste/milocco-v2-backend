import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import { ALL_ENTITIES } from '../entities/all';

@Global()
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        host: config.get<string>('db.host'),
        port: config.get<number>('db.port'),
        database: config.get<string>('db.name'),
        username: config.get<string>('db.user'),
        password: config.get<string>('db.password'),
        entities: ALL_ENTITIES as never[],
        synchronize: false,
        namingStrategy: new SnakeNamingStrategy(),
      }),
    }),
    // Repository di tutte le entità disponibili in ogni modulo con @InjectRepository
    TypeOrmModule.forFeature(ALL_ENTITIES as never[]),
  ],
  exports: [TypeOrmModule],
})
export class DatabaseModule {}
