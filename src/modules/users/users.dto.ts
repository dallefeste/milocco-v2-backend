import { ApiProperty, PartialType } from '@nestjs/swagger';
import { IsBoolean, IsEmail, IsIn, IsOptional, IsString, MinLength } from 'class-validator';
import { USER_ROLES, type UserRole } from '../../shared';

export class CreateUserDto {
  @IsString() @MinLength(2) username!: string;
  @IsString() @MinLength(1) firstName!: string;
  @IsString() @MinLength(1) lastName!: string;
  @IsOptional() @IsEmail() email?: string | null;
  @ApiProperty({ enum: USER_ROLES }) @IsIn(USER_ROLES as unknown as string[]) role!: UserRole;
  @IsOptional() @IsBoolean() enabled?: boolean;
  /** Password iniziale; l'utente dovrà cambiarla al primo accesso. */
  @IsString() @MinLength(6) password!: string;
}

export class UpdateUserDto extends PartialType(CreateUserDto) {}

export class ChangePasswordDto {
  @IsOptional() @IsString() currentPassword?: string;
  @IsString() @MinLength(6) newPassword!: string;
}

export class LoginDto {
  @IsString() username!: string;
  @IsString() password!: string;
}
