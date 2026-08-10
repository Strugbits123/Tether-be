import {
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

export const ROLES_KEY = 'roles';
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);

@Injectable()
export class RoleGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // Handler first, then the controller class. Reading only the handler meant
    // a class-level @Roles(...) was invisible here — requiredRoles came back
    // undefined and this guard allowed every role through. All four rm-portal
    // controllers declare @Roles at class level, so the RM portal was
    // effectively unguarded; the method-level declarations in
    // invitations.controller were the only ones ever enforced.
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!requiredRoles || requiredRoles.length === 0) return true;

    const request = context.switchToHttp().getRequest();
    const accountContext = request.accountContext;
    if (!accountContext) return false;

    return requiredRoles.includes(accountContext.role);
  }
}
