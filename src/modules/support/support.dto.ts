import { IsIn, IsOptional, IsString, MinLength } from 'class-validator';
import { TICKET_PRIORITIES, TICKET_STATUSES, type TicketPriority, type TicketStatus } from '../../shared';

export class CreateTicketDto {
  @IsString() @MinLength(3) subject!: string;
  @IsIn(TICKET_PRIORITIES as unknown as string[]) priority!: TicketPriority;
  @IsString() @MinLength(3) description!: string;
  @IsOptional() @IsString() suggestion?: string | null;
}

export class UpdateTicketDto {
  @IsOptional() @IsString() subject?: string;
  @IsOptional() @IsIn(TICKET_PRIORITIES as unknown as string[]) priority?: TicketPriority;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() suggestion?: string | null;
  @IsOptional() @IsString() feedback?: string | null;
  @IsOptional() @IsIn(TICKET_STATUSES as unknown as string[]) status?: TicketStatus;
}
