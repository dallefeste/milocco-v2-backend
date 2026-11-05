import { Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsNumber, IsOptional, IsString, MaxLength, Min, MinLength, ValidateNested,
} from 'class-validator';
import { TREATMENT_PRICE_UNITS } from '../../shared';
import type { TreatmentPriceUnit } from '../../shared';

// ----------------------------------------------------------------------------- Preventivi

export class QuotePartPhaseDto {
  @Type(() => Number) @IsInt() machineTypeId!: number;
  @IsOptional() @Type(() => Number) @IsInt() machineId?: number | null;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) sequence?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) programmingSeconds?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) setupSeconds?: number;
  @Type(() => Number) @IsInt() @Min(0) unitSeconds!: number;
  @IsOptional() @Type(() => Number) @IsNumber({}, { message: 'Tariffa oraria non valida' }) @Min(0) machineHourlyRate?: number;
}

export class QuotePartTreatmentDto {
  @Type(() => Number) @IsInt() treatmentId!: number;
  @IsOptional() @Type(() => Number) @IsNumber({}, { message: 'Prezzo trattamento non valido' }) @Min(0) unitPrice?: number;
  @IsOptional() @IsIn(TREATMENT_PRICE_UNITS as unknown as string[]) unit?: TreatmentPriceUnit;
}

export class CreateQuotePartDto {
  @Type(() => Number) @IsInt({ message: 'Scegli il particolare' }) partId!: number;
  @Type(() => Number) @IsInt() @Min(0) quantity!: number;
  @Type(() => Number) @IsInt() @Min(0) productionQuantity!: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) camSeconds?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) camPricePerMinute?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) materialPricePerKg?: number;
  @IsOptional() @IsString() notes?: string | null;
  @IsOptional() @Type(() => Number) @IsInt() sortOrder?: number;
  /** Assenti = proposte dal ciclo del particolare. */
  @IsOptional() @IsArray() @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => QuotePartPhaseDto) phases?: QuotePartPhaseDto[];
  /** Assenti = trattamenti dei disegni che contengono il particolare. */
  @IsOptional() @IsArray() @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => QuotePartTreatmentDto) treatments?: QuotePartTreatmentDto[];
}

export class UpdateQuotePartDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) quantity?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) productionQuantity?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) camSeconds?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) camPricePerMinute?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) materialPricePerKg?: number;
  @IsOptional() @IsString() notes?: string | null;
  @IsOptional() @Type(() => Number) @IsInt() sortOrder?: number;
  /** Ricopia peso e superfici dal particolare (i costi passati cambiano solo su richiesta). */
  @IsOptional() @IsBoolean() refreshSnapshot?: boolean;
  /** Presenti = sostituiscono tutte le fasi. */
  @IsOptional() @IsArray() @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => QuotePartPhaseDto) phases?: QuotePartPhaseDto[];
  @IsOptional() @IsArray() @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => QuotePartTreatmentDto) treatments?: QuotePartTreatmentDto[];
}

export class CreateQuoteDto {
  @IsString() @MinLength(1, { message: 'Indica il numero del preventivo' }) @MaxLength(80) number!: string;
  @Type(() => Number) @IsInt({ message: 'Scegli il cliente' }) customerId!: number;
  @IsOptional() @IsDateString({}, { message: 'Data di emissione non valida' }) issueDate?: string;
  @IsOptional() @IsDateString({}, { message: 'Data di consegna non valida' }) expectedDeliveryDate?: string | null;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) materialMarkup?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) markup?: number;
  @IsOptional() @IsString() notes?: string | null;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => CreateQuotePartDto) parts?: CreateQuotePartDto[];
}

export class UpdateQuoteDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(80) number?: string;
  @IsOptional() @Type(() => Number) @IsInt() customerId?: number;
  @IsOptional() @IsDateString() issueDate?: string;
  @IsOptional() @IsDateString() expectedDeliveryDate?: string | null;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) materialMarkup?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) markup?: number;
  @IsOptional() @Type(() => Number) @IsInt() customerOrderId?: number | null;
  @IsOptional() @IsString() notes?: string | null;
}

// ----------------------------------------------------------------------------- Ordini cliente

export class CustomerOrderLineDto {
  /** Assente = nuova riga. */
  @IsOptional() @Type(() => Number) @IsInt() id?: number;
  @Type(() => Number) @IsInt({ message: 'Scegli il disegno' }) drawingId!: number;
  @Type(() => Number) @IsInt({ message: 'Quantità non valida' }) @Min(0) quantity!: number;
  @IsOptional() @IsString() notes?: string | null;
}

export class CreateCustomerOrderDto {
  @IsString() @MinLength(1, { message: "Indica il codice dell'ordine" }) @MaxLength(80) code!: string;
  @Type(() => Number) @IsInt({ message: 'Scegli il cliente' }) customerId!: number;
  @IsOptional() @IsDateString() orderDate?: string;
  @IsOptional() @IsString() notes?: string | null;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => CustomerOrderLineDto) lines?: CustomerOrderLineDto[];
}

export class UpdateCustomerOrderDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(80) code?: string;
  @IsOptional() @Type(() => Number) @IsInt() customerId?: number;
  @IsOptional() @IsDateString() orderDate?: string;
  @IsOptional() @IsString() notes?: string | null;
  /** Presenti = elenco completo delle righe (quelle mancanti vengono eliminate se possibile). */
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => CustomerOrderLineDto) lines?: CustomerOrderLineDto[];
}

export class ConfirmPhaseDto {
  @Type(() => Number) @IsInt() drawingPartId!: number;
  @Type(() => Number) @IsInt() cycleStepId!: number;
  /** null = fase da non pianificare ora (scelta esplicita). */
  @IsOptional() @Type(() => Number) @IsInt() machineId?: number | null;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) internalPauseSeconds?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) endPauseSeconds?: number;
}

export class ConfirmLineDto {
  @Type(() => Number) @IsInt() lineId!: number;
  @Type(() => Number) @IsInt() @Min(1, { message: 'La quantità deve essere almeno 1' }) quantity!: number;
  @Type(() => Number) @IsInt({ message: 'Indica la quantità per magazzino' }) @Min(0) stockQuantity!: number;
  @IsDateString({}, { message: 'Indica la data di consegna prevista' }) expectedDeliveryDate!: string;
  @IsOptional() @IsString() notes?: string | null;
  @IsArray() @ValidateNested({ each: true }) @Type(() => ConfirmPhaseDto) phases!: ConfirmPhaseDto[];
}

export class ConfirmCustomerOrderDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => ConfirmLineDto) lines!: ConfirmLineDto[];
}
