import { ApiProperty, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsDateString, IsIn, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { PRODUCTION_ORDER_STATUSES, type ProductionOrderStatus } from '../../../shared';

export class CreateProductionOrderDto {
  @Type(() => Number) @IsInt({ message: "Scegliere l'ordine cliente" }) customerOrderId!: number;
  @IsOptional() @Type(() => Number) @IsInt() customerOrderLineId?: number | null;
  @Type(() => Number) @IsInt({ message: 'Scegliere il disegno' }) drawingId!: number;
  @Type(() => Number) @IsInt() @Min(1, { message: 'La quantità deve essere almeno 1' }) quantity!: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0, { message: 'La quantità per magazzino non può essere negativa' }) stockQuantity?: number;
  @IsOptional() @IsDateString({}, { message: 'Data di consegna non valida' }) expectedDeliveryDate?: string | null;
  @IsOptional() @IsString() notes?: string | null;
  /** Trattamenti esterni; se assenti in creazione si copiano quelli del disegno. */
  @IsOptional() @IsArray() @IsInt({ each: true }) treatmentIds?: number[];
}

export class UpdateProductionOrderDto extends PartialType(CreateProductionOrderDto) {}

export class ChangeProductionOrderStatusDto {
  @ApiProperty({ enum: PRODUCTION_ORDER_STATUSES })
  @IsIn(PRODUCTION_ORDER_STATUSES as unknown as string[], { message: 'Stato non valido' })
  status!: ProductionOrderStatus;
}
