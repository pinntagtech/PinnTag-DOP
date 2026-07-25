import {
  Body,
  Controller,
  Get,
  HttpException,
  Logger,
  Param,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { EnvGuard } from '../../auth/guards/env.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { DopUserRole } from '../../auth/schemas/dop-user.schema';
import { ConsoleService } from './console.service';
import { GateService } from './gate.service';
import { ProvenanceService } from './provenance.service';
import { RunService } from './run.service';
import type {
  ConsoleActionRequest,
  ConsoleFacetsRequest,
  ConsoleSearchRequest,
  SelectionPreviewRequest,
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
    private readonly provenanceService: ProvenanceService,
    private readonly runService: RunService,
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

  // Materialize Business.seedProvenance across the seeded corpus. Locked
  // to staging in the service. `dryRun` defaults to true — the endpoint
  // reports the breakdown without touching a doc unless the caller
  // explicitly opts in with `dryRun: false`.
  @Roles(DopUserRole.ADMIN, DopUserRole.SUPER_ADMIN)
  @Post('provenance/recompute')
  async provenanceRecompute(
    @Body() body: { environment: string; dryRun?: boolean },
  ) {
    if (!body?.environment) {
      throw new HttpException('environment is required', 400);
    }
    return this.provenanceService.recompute({
      environment: body.environment,
      dryRun: body.dryRun,
    });
  }

  // ── Phase B: actions + runs ─────────────────────────────────────────
  //
  // /action returns { runId } in the same tick. The run itself runs
  // in-process as a fire-and-forget background task inside RunService.
  // Every write action is locked to staging; the run service double-
  // checks this before touching Mongo. dryRun defaults to true — the
  // caller must explicitly opt into a live run.
  @Roles(DopUserRole.ADMIN, DopUserRole.SUPER_ADMIN)
  @Post('action')
  async action(
    @Body() body: ConsoleActionRequest,
    @Request() req: any,
  ) {
    if (!body?.environment) {
      throw new HttpException('environment is required', 400);
    }
    if (!body?.action) {
      throw new HttpException('action is required', 400);
    }
    if (!body?.selection || !body.selection.mode) {
      throw new HttpException(
        'selection { mode: "ids" | "filter" } is required',
        400,
      );
    }
    return this.runService.launch({
      environment: body.environment,
      action: body.action,
      selection: body.selection,
      dryRun: body.dryRun !== false, // default true, must be explicitly disabled
      adminPassword: body.adminPassword,
      options: body.options,
      actor: req.user?.name ?? req.user?.email ?? 'Operator',
    });
  }

  // Resolves a selection into an exact record count. For mode:ids this
  // is trivial (validated length). For mode:filter this hits the same
  // filter builder used by /search, so the count matches what the user
  // sees in the table. NEVER returns the id list itself — that's the
  // whole point of the filter-mode design.
  @Roles(DopUserRole.ADMIN, DopUserRole.SUPER_ADMIN, DopUserRole.OPERATOR)
  @Post('selection/preview')
  async selectionPreview(@Body() body: SelectionPreviewRequest) {
    if (!body?.environment) {
      throw new HttpException('environment is required', 400);
    }
    if (!body?.selection?.mode) {
      throw new HttpException(
        'selection { mode: "ids" | "filter" } is required',
        400,
      );
    }
    const total = await this.runService.previewSelectionCount(
      body.environment,
      body.selection,
    );
    return { total };
  }

  @Roles(DopUserRole.ADMIN, DopUserRole.SUPER_ADMIN, DopUserRole.OPERATOR)
  @Get('runs')
  async listRuns(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.runService.list({
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  }

  @Roles(DopUserRole.ADMIN, DopUserRole.SUPER_ADMIN, DopUserRole.OPERATOR)
  @Get('runs/:runId')
  async getRun(@Param('runId') runId: string) {
    return this.runService.get(runId);
  }
}
