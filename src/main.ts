import 'reflect-metadata';
import { loadEnv } from './config/load-env';
loadEnv();

import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { PostgresErrorFilter } from './common/filters/postgres-error.filter';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // Express 5 non interpreta più filter[x]=... come oggetto: serve il parser esteso.
  app.set('query parser', 'extended');
  const config = app.get(ConfigService);

  app.setGlobalPrefix('api');
  app.enableCors({ origin: config.get<string[]>('corsOrigins'), credentials: true });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new PostgresErrorFilter(app.get(HttpAdapterHost).httpAdapter));

  const swagger = new DocumentBuilder()
    .setTitle('Milocco - API gestionale di produzione')
    .setVersion('2.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, swagger));

  const port = config.get<number>('port')!;
  await app.listen(port);
  Logger.log(`API in ascolto su http://localhost:${port}/api (documentazione: /api/docs)`, 'Avvio');
}
bootstrap();
