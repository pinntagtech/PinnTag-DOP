import {
  Body,
  Controller,
  Get,
  HttpException,
  Logger,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { DbSyncService } from './db-sync.service';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { EnvGuard } from '../../auth/guards/env.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { DopUserRole } from '../../auth/schemas/dop-user.schema';

@UseGuards(JwtAuthGuard, RolesGuard, EnvGuard)
@Controller('seeding/sync')
export class SyncController {
  private readonly logger = new Logger(SyncController.name);

  constructor(private readonly dbSyncService: DbSyncService) {}

  @Post('preview')
  @Roles(DopUserRole.ADMIN, DopUserRole.SUPER_ADMIN)
  async preview(
    @Body() body: { environment: string },
    @Request() req: any,
  ) {
    if (!body?.environment) {
      throw new HttpException('environment is required', 400);
    }
    const actor = req.user?.name || req.user?.email || 'admin';
    this.logger.log(
      `[SYNC] Preview requested by ${actor} for ${body.environment}`,
    );
    return this.dbSyncService.previewSync(body.environment, actor);
  }

  @Post('apply')
  @Roles(DopUserRole.ADMIN, DopUserRole.SUPER_ADMIN)
  async apply(
    @Body() body: { environment: string; adminPassword?: string },
    @Request() req: any,
  ) {
    if (!body?.environment) {
      throw new HttpException('environment is required', 400);
    }
    const actor = req.user?.name || req.user?.email || 'admin';
    this.logger.log(
      `[SYNC] Apply requested by ${actor} for ${body.environment}`,
    );
    try {
      return await this.dbSyncService.applySync(body.environment, {
        adminPassword: body.adminPassword,
        startedBy: actor,
      });
    } catch (err: any) {
      const msg = err?.message ?? 'sync apply failed';
      if (msg.includes('admin password')) {
        throw new HttpException(msg, 403);
      }
      throw new HttpException(msg, 500);
    }
  }

  @Get('runs')
  @Roles(DopUserRole.ADMIN, DopUserRole.SUPER_ADMIN)
  async runs(@Query('environment') environment?: string) {
    return this.dbSyncService.listRuns(environment);
  }
}
