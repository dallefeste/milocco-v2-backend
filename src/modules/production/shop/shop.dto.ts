import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsDateString, IsIn, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { WORK_PHASE_STATUSES, type WorkPhaseStatus } from '../../../shared';
import { ListQueryDto } from '../../../common/crud/list-query.dto';

/** Liste del reparto: oltre ai filtri standard accetta ?productionOrderId= e il periodo ?from=&to= (AAAA-MM-GG). */
export class ShopListQueryDto extends ListQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() productionOrderId?: number;
  @IsOptional() @IsDateString({}, { message: 'Data iniziale non valida' }) from?: string;
  @IsOptional() @IsDateString({}, { message: 'Data finale non valida' }) to?: string;
}

/** Correzione d'ufficio di una fase registrata in reparto. */
export class CorrectWorkPhaseDto {
  @IsOptional() @ApiProperty({ enum: WORK_PHASE_STATUSES }) @IsIn(WORK_PHASE_STATUSES as unknown as string[]) status?: WorkPhaseStatus;
  @IsOptional() @IsDateString() setupStartedAt?: string;
  @IsOptional() @IsDateString() setupEndedAt?: string | null;
  @IsOptional() @IsDateString() workStartedAt?: string | null;
  @IsOptional() @IsDateString() workEndedAt?: string | null;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0, { message: 'I pezzi buoni non possono essere negativi' }) goodQty?: number | null;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0, { message: 'I pezzi scartati non possono essere negativi' }) scrapQty?: number | null;
  /** Motivo della correzione, scritto nel registro modifiche. */
  @IsOptional() @IsString() reason?: string;
}

/** Chiusura d'ufficio di una fase rimasta aperta. */
export class CloseWorkPhaseDto {
  @ApiProperty({ enum: ['COMPLETED', 'SUSPENDED'] }) @IsIn(['COMPLETED', 'SUSPENDED'], { message: 'Indicare se la fase è conclusa o sospesa' })
  status!: 'COMPLETED' | 'SUSPENDED';
  /** Ora di fine; se assente adesso. */
  @IsOptional() @IsDateString() endedAt?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) goodQty?: number | null;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) scrapQty?: number | null;
  @IsOptional() @IsString() reason?: string;
}

export class CorrectWorkStopDto {
  @IsOptional() @IsDateString() startedAt?: string;
  @IsOptional() @IsDateString() endedAt?: string | null;
  @IsOptional() @Type(() => Number) @IsInt() stopReasonId?: number | null;
  @IsOptional() @IsBoolean() machineStopped?: boolean;
  @IsOptional() @IsString() reason?: string;
}

export class CorrectInspectionDto {
  @IsOptional() @IsDateString() startedAt?: string;
  @IsOptional() @IsDateString() endedAt?: string | null;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) goodQty?: number | null;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) scrapQty?: number | null;
  @IsOptional() @IsString() notes?: string | null;
  @IsOptional() @IsString() reason?: string;
}

export class CorrectExtraActivityLogDto {
  @IsOptional() @IsDateString() startedAt?: string;
  @IsOptional() @IsDateString() endedAt?: string | null;
  @IsOptional() @Type(() => Number) @IsInt() extraActivityId?: number;
  @IsOptional() @Type(() => Number) @IsInt() machineId?: number | null;
  @IsOptional() @IsString() reason?: string;
}
