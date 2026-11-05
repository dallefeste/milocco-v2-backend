import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class DeviceLoginDto {
  @IsString() username!: string;
  @IsString() password!: string;
}

export class StartSessionDto {
  @Type(() => Number) @IsInt({ message: 'Operatore non valido' }) operatorId!: number;
  @Type(() => Number) @IsInt({ message: 'Postazione non valida' }) machineId!: number;
  @IsOptional() @IsString() pin?: string;
}

export class StateQueryDto {
  @Type(() => Number) @IsInt() machineId!: number;
  @IsOptional() @Type(() => Number) @IsInt() operatorId?: number;
}

export class SubgroupQueryDto {
  @IsString() subgroup!: string;
}

export class SetupStartDto {
  @Type(() => Number) @IsInt() productionOrderId!: number;
  @Type(() => Number) @IsInt() partId!: number;
  @Type(() => Number) @IsInt() machineId!: number;
  @Type(() => Number) @IsInt() operatorId!: number;
  /** Fase sospesa da riprendere (stesso numero di fase). */
  @IsOptional() @Type(() => Number) @IsInt() resumeFromPhaseId?: number | null;
}

export class OperatorActionDto {
  @Type(() => Number) @IsInt() operatorId!: number;
}

export class WorkEndDto {
  @Type(() => Number) @IsInt() operatorId!: number;
  @Type(() => Number) @IsInt({ message: 'Pezzi buoni non validi' }) @Min(0, { message: 'I pezzi buoni non possono essere negativi' }) goodQty!: number;
  @Type(() => Number) @IsInt({ message: 'Pezzi scartati non validi' }) @Min(0, { message: 'I pezzi scartati non possono essere negativi' }) scrapQty!: number;
  /** Solo taglio: millimetri di barra riposti in magazzino (avanzo). */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0, { message: 'I millimetri non possono essere negativi' }) barReturnMm?: number | null;
}

export class SuspendDto {
  @Type(() => Number) @IsInt() operatorId!: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0, { message: 'I pezzi buoni non possono essere negativi' }) goodQty?: number | null;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0, { message: 'I pezzi scartati non possono essere negativi' }) scrapQty?: number | null;
}

export class StopStartDto {
  @Type(() => Number) @IsInt() operatorId!: number;
  @Type(() => Number) @IsInt({ message: 'Causale di fermo non valida' }) stopReasonId!: number;
  /** true = fermo macchina; false = pausa operatore con macchina in lavorazione. */
  @Type(() => Boolean) @IsBoolean() machineStopped!: boolean;
  /** Per la causale di fine giornata a lavorazione avviata: pezzi da registrare nella sospensione. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) goodQty?: number | null;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) scrapQty?: number | null;
}

export class AvgTimeDto {
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }, { message: 'Tempo medio non valido' }) @Min(0.1, { message: 'Il tempo medio deve essere maggiore di zero' })
  avgUnitSeconds!: number;
}

export class ExtraStartDto {
  @Type(() => Number) @IsInt() operatorId!: number;
  @Type(() => Number) @IsInt({ message: 'Lavoro extra non valido' }) extraActivityId!: number;
  @IsOptional() @Type(() => Number) @IsInt() machineId?: number | null;
}

export class InspectionStartDto {
  @Type(() => Number) @IsInt() productionOrderId!: number;
  @Type(() => Number) @IsInt() operatorId!: number;
  @Type(() => Number) @IsInt() machineId!: number;
}

export class InspectionDataDto {
  @Type(() => Number) @IsInt({ message: 'Pezzi buoni non validi' }) @Min(0, { message: 'I pezzi buoni non possono essere negativi' }) goodQty!: number;
  @Type(() => Number) @IsInt({ message: 'Pezzi scartati non validi' }) @Min(0, { message: 'I pezzi scartati non possono essere negativi' }) scrapQty!: number;
  @IsOptional() @IsString() @MaxLength(4000, { message: 'Le note sono troppo lunghe (massimo 4000 caratteri)' }) notes?: string | null;
}

export class BarMoveDto {
  @IsIn(['LOAD', 'UNLOAD'], { message: 'Operazione non valida' }) kind!: 'LOAD' | 'UNLOAD';
  @Type(() => Number) @IsInt({ message: 'Millimetri non validi' }) @Min(1, { message: 'Inserisci una lunghezza maggiore di zero' }) mm!: number;
  @Type(() => Number) @IsInt() operatorId!: number;
  @IsOptional() @Type(() => Number) @IsInt() productionOrderId?: number | null;
  @IsOptional() @IsString() @MaxLength(200) reason?: string | null;
}
