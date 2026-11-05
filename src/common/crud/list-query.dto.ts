import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, Max, Min } from 'class-validator';

/**
 * Parametri comuni delle liste: paginazione, ricerca libera, ordinamento e filtri.
 * I filtri arrivano come query string `filter[campo]=valore`
 * (più valori separati da virgola = IN; `null` = campo vuoto).
 */
export class ListQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page?: number = 1;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1000)
  pageSize?: number = 25;

  @IsOptional() @IsString()
  search?: string;

  @IsOptional() @IsString()
  sort?: string;

  @IsOptional() @IsIn(['asc', 'desc'])
  order?: 'asc' | 'desc';

  @IsOptional() @IsObject()
  filter?: Record<string, string>;

  @IsOptional() @Transform(({ value }) => value === true || value === 'true') @IsBoolean()
  withDeleted?: boolean;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
