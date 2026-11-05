import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsDateString, IsInt, IsOptional, Min, ValidateNested } from 'class-validator';

/** Tempi di una lavorazione, in secondi. */
export class ScheduleTimesDto {
  @Type(() => Number) @IsInt() @Min(0, { message: "L'attrezzaggio non può essere negativo" }) setupSeconds!: number;
  @Type(() => Number) @IsInt() @Min(0, { message: 'Il tempo per pezzo non può essere negativo' }) unitSeconds!: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0, { message: 'La pausa interna non può essere negativa' }) internalPauseSeconds?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0, { message: 'La pausa di fine lavorazione non può essere negativa' }) endPauseSeconds?: number;
}

export class CreateScheduleItemDto extends ScheduleTimesDto {
  @Type(() => Number) @IsInt({ message: "Scegliere l'ordine di produzione" }) productionOrderId!: number;
  @Type(() => Number) @IsInt({ message: 'Scegliere il particolare' }) partId!: number;
  @Type(() => Number) @IsInt({ message: 'Scegliere la macchina' }) machineId!: number;
  /** Posizione in coda (1 = in testa); se assente va in fondo. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) position?: number | null;
}

export class BulkCreateScheduleItemsDto {
  @Type(() => Number) @IsInt({ message: "Scegliere l'ordine di produzione" }) productionOrderId!: number;
  @Type(() => Number) @IsInt({ message: 'Scegliere il particolare' }) partId!: number;
  @Type(() => Number) @IsInt({ message: 'Scegliere la macchina' }) machineId!: number;
  @IsArray() @ArrayMinSize(1, { message: 'Inserire almeno una lavorazione' }) @ValidateNested({ each: true }) @Type(() => ScheduleTimesDto)
  rows!: ScheduleTimesDto[];
}

export class UpdateScheduleItemDto {
  @IsOptional() @Type(() => Number) @IsInt() partId?: number;
  @IsOptional() @Type(() => Number) @IsInt() machineId?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) position?: number | null;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) setupSeconds?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) unitSeconds?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) internalPauseSeconds?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) endPauseSeconds?: number;
}

export class MoveScheduleItemDto {
  @Type(() => Number) @IsInt({ message: 'Indicare la macchina' }) machineId!: number;
  /** Posizione di arrivo (1 = in testa); se assente in fondo. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) position?: number | null;
}

export class ProposalQueryDto {
  @Type(() => Number) @IsInt() productionOrderId!: number;
  @Type(() => Number) @IsInt() partId!: number;
  @Type(() => Number) @IsInt() machineId!: number;
}

export class PeriodQueryDto {
  @IsOptional() @IsDateString({}, { message: 'Data iniziale non valida' }) from?: string;
  @IsOptional() @IsDateString({}, { message: 'Data finale non valida' }) to?: string;
}
