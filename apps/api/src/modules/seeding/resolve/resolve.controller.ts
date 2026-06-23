import {
  Body,
  Controller,
  Get,
  Headers,
  HttpException,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { EnvGuard } from '../../auth/guards/env.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { Public } from '../../auth/decorators/public.decorator';
import { DopUserRole } from '../../auth/schemas/dop-user.schema';
import { ResolveService } from './resolve.service';
import type { ResolveWebhookPayload } from './resolve.service';

@Controller('seeding/resolve-business')
export class ResolveController {
  constructor(
    private readonly resolveService: ResolveService,
    private readonly configService: ConfigService,
  ) {}

  // ── Operator endpoints (ADMIN/SUPER_ADMIN only) ────────────────────────

  @UseGuards(JwtAuthGuard, RolesGuard, EnvGuard)
  @Roles(DopUserRole.ADMIN, DopUserRole.SUPER_ADMIN)
  @Get('candidates')
  async listCandidates(
    @Query('environment') environment: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
    @Query('city') city?: string,
    @Query('state') state?: string,
  ) {
    if (!environment) {
      throw new HttpException('environment query param is required', 400);
    }
    return this.resolveService.listCandidates({
      environment,
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? parseInt(limit, 10) : 25,
      search,
      city,
      state,
    });
  }

  @UseGuards(JwtAuthGuard, RolesGuard, EnvGuard)
  @Roles(DopUserRole.ADMIN, DopUserRole.SUPER_ADMIN)
  @Get('review')
  async listForReview(
    @Query('environment') environment: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    if (!environment) {
      throw new HttpException('environment query param is required', 400);
    }
    return this.resolveService.listForReview(
      environment,
      page ? parseInt(page, 10) : 1,
      limit ? parseInt(limit, 10) : 25,
    );
  }

  @UseGuards(JwtAuthGuard, RolesGuard, EnvGuard)
  @Roles(DopUserRole.ADMIN, DopUserRole.SUPER_ADMIN)
  @Post('trigger')
  async trigger(
    @Body()
    body: {
      environment: string;
      businessIds: string[];
      force?: boolean;
      // Optional label carried onto the dopFixBatches doc — surfaces
      // in the email subject as "DOP Fix complete — <city> — N/M".
      city?: string;
    },
  ) {
    if (!body?.environment) {
      throw new HttpException('environment is required', 400);
    }
    if (!Array.isArray(body.businessIds)) {
      throw new HttpException('businessIds[] is required', 400);
    }
    return this.resolveService.triggerResolve({
      environment: body.environment,
      businessIds: body.businessIds,
      force: body.force === true,
      city: body.city,
    });
  }

  // Operator one-click for "Re-resolve unresolved + flagged" — enqueues
  // the full work-set (review + never-resolved authentic candidates),
  // caps a single call at 1000, returns `remaining` so the operator
  // can click again until the queue is drained.
  @UseGuards(JwtAuthGuard, RolesGuard, EnvGuard)
  @Roles(DopUserRole.ADMIN, DopUserRole.SUPER_ADMIN)
  @Post('retrigger-review')
  async retriggerReview(
    @Body() body: { environment: string; limit?: number },
  ) {
    if (!body?.environment) {
      throw new HttpException('environment is required', 400);
    }
    if (
      body.limit !== undefined &&
      (typeof body.limit !== 'number' || body.limit < 1)
    ) {
      throw new HttpException('limit must be a positive number', 400);
    }
    return this.resolveService.retriggerReview({
      environment: body.environment,
      limit: body.limit,
    });
  }

  // ── Bot webhook (Public, x-bot-secret guarded inline) ──────────────────
  //
  // Separate endpoint from /seeding/bot/webhook so we never accidentally
  // hand a resolve payload to BotWebhookService (which would try to
  // process gallery/menu/reviews fields it doesn't carry).

  @Public()
  @Post('webhook')
  async webhook(
    @Body() payload: ResolveWebhookPayload,
    @Headers('x-bot-secret') secret: string,
  ): Promise<{ message: string; status: 'done' | 'review'; reason?: string }> {
    const expected = this.configService.get<string>('app.botWebhookSecret');
    if (expected && secret !== expected) {
      throw new HttpException('Unauthorized', 401);
    }
    const outcome = await this.resolveService.handleResolveWebhook(payload);
    return { message: 'Resolve webhook processed', ...outcome };
  }
}
