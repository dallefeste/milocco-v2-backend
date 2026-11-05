import { Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsNotEmpty, IsNumber, IsObject, IsOptional, IsString, MaxLength, Min, ValidateNested,
} from 'class-validator';
import { WEIGHT_SHAPES } from './weight-calculator';

const SHAPE_KEYS = WEIGHT_SHAPES.map((s) => s.key);

// ---------------------------------------------------------------------------- Disegni

export class DrawingPartLineDto {
  @Type(() => Number) @IsInt({ message: 'Particolare non valido' }) partId!: number;
  @Type(() => Number) @IsInt({ message: 'La quantità deve essere un numero intero' }) @Min(1, { message: 'La quantità deve essere almeno 1' })
  quantity!: number;
  @IsOptional() @Type(() => Number) @IsInt({ message: 'La posizione deve essere un numero intero' }) @Min(1, { message: 'La posizione deve essere almeno 1' })
  position?: number;
}

export class CreateDrawingDto {
  @IsString() @IsNotEmpty({ message: 'Il codice del disegno è obbligatorio' }) @MaxLength(80, { message: 'Codice troppo lungo (massimo 80 caratteri)' })
  code!: string;
  @IsOptional() @IsString() @MaxLength(10, { message: 'Revisione troppo lunga (massimo 10 caratteri)' }) revision?: string;
  @IsOptional() @IsString() @MaxLength(200, { message: 'Denominazione troppo lunga (massimo 200 caratteri)' }) name?: string;
  @IsOptional() @IsString() notes?: string | null;
  /** Composizione completa: sostituisce quella esistente. */
  @IsOptional() @IsArray() @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => DrawingPartLineDto)
  parts?: DrawingPartLineDto[];
  /** Trattamenti esterni previsti: sostituiscono quelli esistenti. */
  @IsOptional() @IsArray() @IsInt({ each: true }) treatmentIds?: number[];
  /**
   * Creazione rapida (es. dalla riga di un ordine cliente): se `parts` non è indicato, crea anche il particolare
   * "<codice>.<revisione>" con la stessa denominazione (o usa quello già esistente con quel codice) con quantità 1.
   */
  @IsOptional() @IsBoolean() withPart?: boolean;
}

export class UpdateDrawingDto {
  @IsOptional() @IsString() @IsNotEmpty({ message: 'Il codice del disegno è obbligatorio' }) @MaxLength(80, { message: 'Codice troppo lungo (massimo 80 caratteri)' })
  code?: string;
  @IsOptional() @IsString() @MaxLength(10, { message: 'Revisione troppo lunga (massimo 10 caratteri)' }) revision?: string;
  @IsOptional() @IsString() @MaxLength(200, { message: 'Denominazione troppo lunga (massimo 200 caratteri)' }) name?: string;
  @IsOptional() @IsString() notes?: string | null;
  @IsOptional() @IsArray() @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => DrawingPartLineDto)
  parts?: DrawingPartLineDto[];
  @IsOptional() @IsArray() @IsInt({ each: true }) treatmentIds?: number[];
}

// ---------------------------------------------------------------------------- Particolari

export class CycleStepDto {
  /** Id della fase esistente (assente per le nuove). */
  @IsOptional() @Type(() => Number) @IsInt() id?: number;
  @Type(() => Number) @IsInt({ message: 'Scegli la tipologia macchina di ogni fase' }) machineTypeId!: number;
  @Type(() => Number) @IsInt({ message: "Il tempo di attrezzaggio deve essere in secondi interi" }) @Min(0, { message: "Il tempo di attrezzaggio non può essere negativo" })
  setupSeconds!: number;
  @Type(() => Number) @IsInt({ message: 'Il tempo per pezzo deve essere in secondi interi' }) @Min(0, { message: 'Il tempo per pezzo non può essere negativo' })
  unitSeconds!: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) plannedManMinutes?: number | null;
}

class PartFieldsDto {
  @IsOptional() @IsString() @MaxLength(200, { message: 'Denominazione troppo lunga (massimo 200 caratteri)' }) name?: string;
  @IsOptional() @Type(() => Number) @IsInt() materialId?: number | null;
  @IsOptional() @Type(() => Number) @IsInt() supplierId?: number | null;
  @IsOptional() @IsString() @MaxLength(200, { message: 'Testo dimensioni troppo lungo (massimo 200 caratteri)' }) dimensions?: string | null;
  @IsOptional() @IsIn(SHAPE_KEYS, { message: 'Forma non valida' }) shape?: string | null;
  @IsOptional() @IsObject() shapeParams?: Record<string, number> | null;
  @IsOptional() @Type(() => Number) @IsNumber({}, { message: 'Lunghezza di taglio non valida' }) @Min(0) cutLengthMm?: number | null;
  @IsOptional() @Type(() => Number) @IsNumber({}, { message: 'Peso non valido' }) @Min(0, { message: 'Il peso non può essere negativo' }) weightKg?: number | null;
  @IsOptional() @Type(() => Number) @IsNumber({}, { message: 'Superficie da trattare non valida' }) @Min(0) treatmentDm2?: number | null;
  @IsOptional() @Type(() => Number) @IsNumber({}, { message: 'Peso da trattare non valido' }) @Min(0) treatmentKg?: number | null;
  @IsOptional() @IsString() notes?: string | null;
  @IsOptional() @IsBoolean() barCut?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() barTypeId?: number | null;
  /** Ciclo completo nell'ordine voluto: sostituisce quello esistente (sequenza = posizione nell'elenco). */
  @IsOptional() @IsArray() @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => CycleStepDto)
  cycle?: CycleStepDto[];
}

export class CreatePartDto extends PartFieldsDto {
  @IsString() @IsNotEmpty({ message: 'Il codice interno del particolare è obbligatorio' }) @MaxLength(80, { message: 'Codice troppo lungo (massimo 80 caratteri)' })
  internalCode!: string;
}

export class UpdatePartDto extends PartFieldsDto {
  @IsOptional() @IsString() @IsNotEmpty({ message: 'Il codice interno del particolare è obbligatorio' }) @MaxLength(80, { message: 'Codice troppo lungo (massimo 80 caratteri)' })
  internalCode?: string;
}

export class WeightPreviewDto {
  @IsIn(SHAPE_KEYS, { message: 'Scegli una forma' }) shape!: string;
  @IsObject({ message: 'Inserisci le misure' }) params!: Record<string, number>;
  @IsOptional() @Type(() => Number) @IsInt() materialId?: number | null;
  /** Densità g/cm³ alternativa al materiale (se il materiale non è ancora scelto). */
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) density?: number | null;
}
