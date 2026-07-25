import {
  Body,
  Controller,
  Get,
  HttpException,
  Logger,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { EnvGuard } from '../../auth/guards/env.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { DopUserRole } from '../../auth/schemas/dop-user.schema';
import { ConsoleService } from './console.service';
import { GateService } from './gate.service';
import type {
  ConsoleFacetsRequest,
  ConsoleSearchRequest,
} from './console.types';

// Phase A is read-only. The only "write" endpoint is gate/recompute,
// which touches ONLY the gateStatus subdoc — no business fields, no
// media, no cascade. Every other mutation stays out of this controller
// until Phase B lands.
@UseGuards(JwtAuthGuard, RolesGuard, EnvGuard)
@Controller('seeding/console')
export class ConsoleController {
  private readonly logger = new Logger(ConsoleController.name);

  constructor(
    private readonly consoleService: ConsoleService,
    private readonly gateService: GateService,
  ) {}

  @Roles(DopUserRole.ADMIN, DopUserRole.SUPER_ADMIN, DopUserRole.OPERATOR)
  @Post('search')
  async search(@Body() body: ConsoleSearchRequest) {
    if (!body?.environment) {
      throw new HttpException('environment is required', 400);
    }
    return this.consoleService.search(body);
  }

  @Roles(DopUserRole.ADMIN, DopUserRole.SUPER_ADMIN, DopUserRole.OPERATOR)
  @Post('facets')
  async facets(@Body() body: ConsoleFacetsRequest) {
    if (!body?.environment) {
      throw new HttpException('environment is required', 400);
    }
    return this.consoleService.facets(body);
  }

  @Roles(DopUserRole.ADMIN, DopUserRole.SUPER_ADMIN, DopUserRole.OPERATOR)
  @Get('gate/freshness')
  async freshness(@Query('environment') environment?: string) {
    if (!environment) {
      throw new HttpException('environment is required', 400);
    }
    return this.gateService.freshness(environment);
  }

  // Recompute writes only gateStatus.* — no business fields, no media.
  // Runs synchronously within the request; on the staging corpus this
  // completes in seconds. If it starts hitting an nginx timeout, promote
  // it into the run system (Phase B) — entry point stays the same.
  @Roles(DopUserRole.ADMIN, DopUserRole.SUPER_ADMIN)
  @Post('gate/recompute')
  async recompute(@Body() body: { environment: string }) {
    if (!body?.environment) {
      throw new HttpException('environment is required', 400);
    }
    return this.gateService.recompute(body.environment);
  }
}
