import { SetMetadata } from '@nestjs/common';
import { DopUserRole } from '../schemas/dop-user.schema';

export const ROLES_KEY = 'roles';
export const Roles = (...roles: DopUserRole[]) =>
  SetMetadata(ROLES_KEY, roles);
