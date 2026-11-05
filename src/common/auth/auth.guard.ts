import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { UserRole } from '../../shared';
import { AuthUser, IS_PUBLIC_KEY, ROLES_KEY } from './decorators';
import { requestContext } from '../context/request-context';

/**
 * Controlla il token di accesso su ogni rotta (salvo quelle @Public) e i ruoli richiesti.
 * Senza @Roles la rotta è aperta agli utenti del backoffice (ADMIN e OFFICE), non al tablet.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) return true;

    const request = context.switchToHttp().getRequest();
    const header: string | undefined = request.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : (request.query?.token as string | undefined);
    if (!token) throw new UnauthorizedException('Accesso richiesto');

    let user: AuthUser;
    try {
      const payload = await this.jwt.verifyAsync<{ sub: number; username: string; role: UserRole }>(token);
      user = { id: payload.sub, username: payload.username, role: payload.role };
    } catch {
      throw new UnauthorizedException('Sessione scaduta, accedi di nuovo');
    }
    request.user = user;
    const store = requestContext.getStore();
    if (store) { store.userId = user.id; store.username = user.username; }

    const roles = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, targets) ?? ['ADMIN', 'OFFICE'];
    if (!roles.includes(user.role)) throw new ForbiddenException('Non hai i permessi per questa operazione');
    return true;
  }
}
