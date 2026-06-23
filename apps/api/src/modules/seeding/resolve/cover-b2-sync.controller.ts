import {
  Body,
  Controller,
  Get,
  HttpException,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { EnvGuard } from '../../auth/guards/env.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { DopUserRole } from '../../auth/schemas/dop-user.schema';
import { CoverB2SyncService } from './cover-b2-sync.service';

@Controller('seeding/cover-b2-sync')
export class CoverB2SyncController {
  constructor(
    private readonly coverB2SyncService: CoverB2SyncService,
  ) {}

  // Count of businesses with a pendingCoverUrl + no cover yet. The
  // portal renders the run button as "Sync pending covers (N)".
  @UseGuards(JwtAuthGuard, RolesGuard, EnvGuard)
  @Roles(DopUserRole.ADMIN, DopUserRole.SUPER_ADMIN)
  @Get('pending')
  async pending(@Query('environment') environment: string) {
    if (!environment) {
      throw new HttpException('environment query param is required', 400);
    }
    return this.coverB2SyncService.countPending(environment);
  }

  // Batch sync. limit defaults to 50, capped at 200. dryRun reports
  // what would happen without doing any B2 work.
  @UseGuards(JwtAuthGuard, RolesGuard, EnvGuard)
  @Roles(DopUserRole.ADMIN, DopUserRole.SUPER_ADMIN)
  @Post('run')
  async run(
    @Body()
    body: { environment: string; limit?: number; dryRun?: boolean },
  ) {
    if (!body?.environment) {
      throw new HttpException('environment is required', 400);
    }
    return this.coverB2SyncService.runBatch({
      environment: body.environment,
      limit: body.limit,
      dryRun: body.dryRun === true,
    });
  }
}
