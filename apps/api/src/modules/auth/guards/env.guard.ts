import {
  CanActivate,
  ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { DopUserRole } from '../schemas/dop-user.schema';

@Injectable()
export class EnvGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(
      IS_PUBLIC_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (!user) return false;

    if (user.role === DopUserRole.SUPER_ADMIN) return true;

    const env =
      request.body?.environment ||
      request.query?.environment ||
      request.params?.environment;

    if (!env) return true;

    return user.environments?.includes(env) ?? false;
  }
}
