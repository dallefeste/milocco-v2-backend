import { ApiProperty, OmitType, PartialType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsNotEmpty, IsNumber, IsOptional, IsPositive,
  IsString, Length, Matches, Max, MaxLength, Min, ValidateNested,
} from 'class-validator';
import { BAR_SHAPES, STOP_KINDS, TREATMENT_PRICE_UNITS, type StopKind, type TreatmentPriceUnit } from '../../shared';
import { EmptyToNull, Trim, UpperTrim } from './masterdata.common';

const required = (label: string) => ({ message: `${label}: campo obbligatorio` });

// ---------------------------------------------------------------- clienti, fornitori, reparti

export class CreateCustomerDto {
  @Trim() @IsString() @IsNotEmpty(required('Nome')) @MaxLength(200) name!: string;
  @IsOptional() @EmptyToNull() @IsString() notes?: string | null;
}
export class UpdateCustomerDto extends PartialType(CreateCustomerDto) {}

export class CreateSupplierDto {
  @Trim() @IsString() @IsNotEmpty(required('Nome')) @MaxLength(200) name!: string;
  @IsOptional() @EmptyToNull() @IsString() notes?: string | null;
}
export class UpdateSupplierDto extends PartialType(CreateSupplierDto) {}

export class CreateDepartmentDto {
  @Trim() @IsString() @IsNotEmpty(required('Nome')) @MaxLength(100) name!: string;
  /** I suoi operatori usano il tablet e compaiono nei riepiloghi giornalieri. */
  @IsOptional() @IsBoolean() isProduction?: boolean;
}
export class UpdateDepartmentDto extends PartialType(CreateDepartmentDto) {}

// ---------------------------------------------------------------- operatori

export class CreateOperatorDto {
  @Trim() @IsString() @IsNotEmpty(required('Nome')) @MaxLength(100) firstName!: string;
  @Trim() @IsString() @IsNotEmpty(required('Cognome')) @MaxLength(100) lastName!: string;
  @IsOptional() @IsInt() departmentId?: number | null;
  @IsOptional() @EmptyToNull() @Trim() @IsString() @MaxLength(50) badgeNumber?: string | null;
  @IsOptional() @EmptyToNull() @IsDateString({}, { message: 'Data di nascita non valida' }) birthDate?: string | null;
  @IsOptional() @EmptyToNull() @IsDateString({}, { message: 'Data di assunzione non valida' }) hireDate?: string | null;
  @IsOptional() @IsBoolean() active?: boolean;
}
export class UpdateOperatorDto extends PartialType(CreateOperatorDto) {}

export class SetPinDto {
  @ApiProperty({ description: 'PIN numerico di 4-8 cifre' })
  @IsString() @Matches(/^\d{4,8}$/, { message: 'Il PIN deve avere da 4 a 8 cifre' }) pin!: string;
}

// ---------------------------------------------------------------- macchine

export class CreateMachineTypeDto {
  @Trim() @IsString() @IsNotEmpty(required('Nome')) @MaxLength(100) name!: string;
  @IsOptional() @IsBoolean() isCutting?: boolean;
  @IsOptional() @IsBoolean() isInspection?: boolean;
  @IsOptional() @IsBoolean() planOnOrderConfirm?: boolean;
  @IsOptional() @EmptyToNull() @UpperTrim() @IsString() @MaxLength(50) excelColumn?: string | null;
  @IsOptional() @IsInt() @Min(0) @Max(100000) sortOrder?: number;
}
export class UpdateMachineTypeDto extends PartialType(CreateMachineTypeDto) {}

export class CreateMachineDto {
  @Trim() @IsString() @IsNotEmpty(required('Nome')) @MaxLength(100) name!: string;
  @IsInt(required('Tipologia macchina')) machineTypeId!: number;
  @IsOptional() @IsNumber({}, { message: 'Prezzo orario: inserire un numero' }) @Min(0, { message: 'Il prezzo orario non può essere negativo' }) hourlyRate?: number;
  @IsOptional() @IsBoolean() schedulable?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(100000) sortOrder?: number;
}
export class UpdateMachineDto extends PartialType(CreateMachineDto) {}

export class CustomerRateDto {
  @IsInt(required('Cliente')) customerId!: number;
  @IsNumber({}, { message: 'Prezzo orario: inserire un numero' }) @Min(0, { message: 'Il prezzo orario non può essere negativo' }) hourlyRate!: number;
}
export class UpdateCustomerRateDto {
  @IsNumber({}, { message: 'Prezzo orario: inserire un numero' }) @Min(0, { message: 'Il prezzo orario non può essere negativo' }) hourlyRate!: number;
}

// ---------------------------------------------------------------- materiali, finiture, trattamenti

export class CreateMaterialDto {
  @Trim() @IsString() @IsNotEmpty(required('Nome')) @MaxLength(100) name!: string;
  /** Codice usato nel codice articolo delle barre (es. FE04). */
  @IsOptional() @EmptyToNull() @UpperTrim() @IsString()
  @Matches(/^[A-Z0-9]{2,8}$/, { message: 'Il codice materiale deve avere da 2 a 8 lettere o cifre, senza spazi (es. FE04)' })
  code?: string | null;
  @IsOptional() @IsNumber({}, { message: 'Densità: inserire un numero' }) @Min(0, { message: 'La densità non può essere negativa' }) density?: number;
  @IsOptional() @IsNumber({}, { message: 'Prezzo al kg: inserire un numero' }) @Min(0, { message: 'Il prezzo non può essere negativo' }) pricePerKg?: number;
}
export class UpdateMaterialDto extends PartialType(CreateMaterialDto) {}

export class CreateFinishDto {
  @Trim() @IsString() @IsNotEmpty(required('Nome')) @MaxLength(100) name!: string;
  /** Una lettera (o "-" per nessuna finitura): non modificabile dopo la creazione. */
  @UpperTrim() @IsString() @Length(1, 1, { message: 'Il codice finitura è di un solo carattere (es. T, L, -)' }) code!: string;
}
export class UpdateFinishDto extends PartialType(OmitType(CreateFinishDto, ['code'] as const)) {}

export class CreateTreatmentDto {
  @Trim() @IsString() @IsNotEmpty(required('Nome')) @MaxLength(150) name!: string;
  @IsOptional() @IsInt({ message: 'Giorni necessari: inserire un numero intero' }) @Min(0) @Max(365) requiredDays?: number;
  @IsOptional() @IsNumber({}, { message: 'Prezzo unitario: inserire un numero' }) @Min(0, { message: 'Il prezzo non può essere negativo' }) unitPrice?: number | null;
  @ApiProperty({ enum: TREATMENT_PRICE_UNITS, required: false, nullable: true })
  @IsOptional() @IsIn(TREATMENT_PRICE_UNITS as unknown as string[], { message: 'Unità di prezzo non valida (kg o dm²)' }) unit?: TreatmentPriceUnit | null;
}
export class UpdateTreatmentDto extends PartialType(CreateTreatmentDto) {}

// ---------------------------------------------------------------- causali di fermo, lavori extra

export class CreateStopReasonDto {
  @Trim() @IsString() @IsNotEmpty(required('Nome')) @MaxLength(100) name!: string;
  @IsOptional() @EmptyToNull() @IsString() description?: string | null;
  @ApiProperty({ enum: STOP_KINDS })
  @IsOptional() @IsIn(STOP_KINDS as unknown as string[], { message: 'Tipo non valido (pausa o interruzione)' }) kind?: StopKind;
  @IsOptional() @IsBoolean() endsWorkday?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(100000) sortOrder?: number;
}
export class UpdateStopReasonDto extends PartialType(CreateStopReasonDto) {}

export class CreateExtraActivityDto {
  @Trim() @IsString() @IsNotEmpty(required('Nome')) @MaxLength(150) name!: string;
}
export class UpdateExtraActivityDto extends PartialType(CreateExtraActivityDto) {}

// ---------------------------------------------------------------- orario di lavoro

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

export class WorkCalendarDayDto {
  @IsOptional() @IsInt() @Min(0) @Max(6) weekday?: number;
  /** Giorno di chiusura: ore ignorate. */
  @IsOptional() @IsBoolean() closed?: boolean;
  @IsOptional() @EmptyToNull() @Matches(TIME_RE, { message: 'Ora di inizio non valida (formato HH:MM)' }) startTime?: string | null;
  @IsOptional() @EmptyToNull() @Matches(TIME_RE, { message: 'Ora di fine non valida (formato HH:MM)' }) endTime?: string | null;
}

export class WorkCalendarWeekDto {
  @IsArray() @ArrayMinSize(7) @ArrayMaxSize(7) @ValidateNested({ each: true }) @Type(() => WorkCalendarDayDto)
  days!: WorkCalendarDayDto[];
}

export class CreateClosureDto {
  @IsDateString({}, { message: 'Data non valida' }) day!: string;
  /** Facoltativo: chiude tutti i giorni da `day` a `toDay` compresi (es. ferie). */
  @IsOptional() @EmptyToNull() @IsDateString({}, { message: 'Data di fine non valida' }) toDay?: string | null;
  @IsOptional() @EmptyToNull() @Trim() @IsString() @MaxLength(200) reason?: string | null;
}
export class UpdateClosureDto {
  @IsOptional() @IsDateString({}, { message: 'Data non valida' }) day?: string;
  @IsOptional() @EmptyToNull() @Trim() @IsString() @MaxLength(200) reason?: string | null;
}

// ---------------------------------------------------------------- barre

export class CreateBarTypeDto {
  @IsInt(required('Materiale')) materialId!: number;
  @ApiProperty({ enum: Object.keys(BAR_SHAPES) })
  @UpperTrim() @IsIn(Object.keys(BAR_SHAPES), { message: `Forma non valida: ammesse ${Object.keys(BAR_SHAPES).join(', ')}` }) shape!: string;
  @IsInt(required('Finitura')) finishId!: number;
  @Transform(({ value }) => (typeof value === 'string' ? value.replace(/\s+/g, '').toUpperCase() : value)) @IsString() @IsNotEmpty(required('Dimensioni')) @MaxLength(60)
  @Matches(/^[A-Z0-9.,X\-/]+$/, { message: 'Dimensioni: solo lettere, cifre e i simboli . , - / (es. 100X10)' })
  dimensions!: string;
}
export class UpdateBarTypeDto extends PartialType(CreateBarTypeDto) {}
export class PreviewBarTypeDto extends PartialType(CreateBarTypeDto) {}

export class BarMovementDto {
  @ApiProperty({ description: 'Metri lineari (per la rettifica: nuova giacenza)' })
  @IsNumber({}, { message: 'Metri: inserire un numero' }) @Min(0, { message: 'Valore negativo non ammesso' }) @Max(1_000_000) meters!: number;
  @IsOptional() @EmptyToNull() @Trim() @IsString() @MaxLength(300) reason?: string | null;
  @IsOptional() @IsInt() operatorId?: number | null;
  @IsOptional() @IsInt() productionOrderId?: number | null;
}

export class BarLoadDto extends BarMovementDto {
  @IsPositive({ message: 'La quantità deve essere maggiore di zero' }) declare meters: number;
}
