import {
  Controller,
  Get,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { CoverBackfillService } from './cover-backfill.service';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { EnvGuard } from '../../auth/guards/env.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { DopUserRole } from '../../auth/schemas/dop-user.schema';

@UseGuards(JwtAuthGuard, RolesGuard, EnvGuard)
@Controller('seeding/cover-backfill')
export class CoverBackfillController {
  constructor(
    private readonly coverBackfillService: CoverBackfillService,
  ) {}

  @Roles(DopUserRole.ADMIN, DopUserRole.SUPER_ADMIN, DopUserRole.OPERATOR)
  @Get('stats')
  async getStats() {
    return this.coverBackfillService.getStats();
  }

  @Roles(DopUserRole.ADMIN, DopUserRole.SUPER_ADMIN, DopUserRole.OPERATOR)
  @Post('queue-batch')
  async queueBatch(@Request() req: any) {
    const actor = req.user?.name || 'Operator';
    return this.coverBackfillService.queueBatch(actor);
  }
}
