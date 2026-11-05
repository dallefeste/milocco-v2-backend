import { ArgumentsHost, Catch, ConflictException, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { QueryFailedError } from 'typeorm';

/** Traduce gli errori del database più comuni in messaggi comprensibili. */
@Catch(QueryFailedError)
export class PostgresErrorFilter extends BaseExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('Database');

  catch(exception: QueryFailedError & { code?: string; detail?: string }, host: ArgumentsHost): void {
    let mapped: HttpException | undefined;
    if (exception.code === '23505') mapped = new ConflictException(`Esiste già un elemento con questi dati. ${exception.detail ?? ''}`.trim());
    if (exception.code === '23503') mapped = new ConflictException('Operazione non possibile: l\'elemento è collegato ad altri dati.');
    if (exception.code === '23502') mapped = new ConflictException('Manca un campo obbligatorio.');
    if (!mapped) this.logger.error(exception.message, exception.stack);
    super.catch(mapped ?? exception, host);
  }
}
