import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { LoginResponse } from '../../shared';
import { AuthUser, CurrentUser, Public, Roles } from '../../common/auth/decorators';
import { ChangePasswordDto, LoginDto } from '../users/users.dto';
import { UsersService } from '../users/users.service';

@ApiTags('Accesso')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly users: UsersService,
    private readonly jwt: JwtService,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(@Body() dto: LoginDto): Promise<LoginResponse> {
    const user = await this.users.validateCredentials(dto.username, dto.password);
    const accessToken = await this.jwt.signAsync({ sub: user.id, username: user.username, role: user.role });
    return {
      accessToken,
      user: {
        id: user.id,
        username: user.username,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        mustChangePassword: user.mustChangePassword,
      },
    };
  }

  @ApiBearerAuth()
  @Roles('ADMIN', 'OFFICE', 'TABLET')
  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.users.findOne(user.id);
  }

  @ApiBearerAuth()
  @Roles('ADMIN', 'OFFICE', 'TABLET')
  @Post('change-password')
  @HttpCode(204)
  async changePassword(@CurrentUser() user: AuthUser, @Body() dto: ChangePasswordDto): Promise<void> {
    await this.users.changePassword(user.id, dto.currentPassword, dto.newPassword);
  }
}
