import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { UserRole } from '../../shared';

export const IS_PUBLIC_KEY = 'isPublic';
/** Rotta accessibile senza login. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export const ROLES_KEY = 'roles';
/** Ruoli ammessi sulla rotta (se assente: qualunque utente autenticato tranne il tablet). */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);

export interface AuthUser {
  id: number;
  username: string;
  role: UserRole;
}

/** Utente autenticato della richiesta corrente. */
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthUser => {
  return ctx.switchToHttp().getRequest().user;
});
