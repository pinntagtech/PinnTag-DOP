import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  Headers,
  HttpException,
  Logger,
  Request,
  UseGuards,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import mongoose from 'mongoose';
import { SeedingSessionService } from './seeding-session.service';
import { SeedingRecordService } from './seeding-record.service';
import { SeedingLogService } from './seeding-log.service';
import { SeedingPipelineService } from './seeding-pipeline.service';
import { BotWebhookService } from './bot/bot-webhook.service';
import { BotJobService } from './bot/bot-job.service';
import { BotJobType } from './schemas/bot-job.schema';
import { MigrationService } from './migration/migration.service';
import { VerifyAndFixService } from './verify/verify-and-fix.service';
import { CvbService } from './cvb/cvb.service';
import { CvbProdMigrationService } from './cvb-migration/cvb-prod-migration.service';
import { LocationsService } from '../locations/locations.service';
import { CreateSeedingSessionDto } from './dto/create-seeding-session.dto';
import { BulkUploadRecordsDto } from './dto/bulk-upload-records.dto';
import { PublishSessionDto } from './dto/publish-session.dto';
import { adaptScraperData } from './engines/scraper-adapter';
import { computeDominant } from './common/dominant';
import { GOOGLE_IMAGE_HOST_REGEX } from './common/google-url';
import {
  SeedingModules,
  SeedingRecordStatus,
  SeedingSessionStatus,
  SeedingLogActions,
  EnvironmentUriKey,
} from '../../common/constants';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { EnvGuard } from '../auth/guards/env.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { DopUserRole } from '../auth/schemas/dop-user.schema';

@UseGuards(JwtAuthGuard, RolesGuard, EnvGuard)
@Controller('seeding')
export class SeedingController {
  private readonly logger = new Logger(SeedingController.name);

  constructor(
    private readonly sessionService: SeedingSessionService,
    private readonly recordService: SeedingRecordService,
    private readonly logService: SeedingLogService,
    private readonly pipelineService: SeedingPipelineService,
    private readonly botWebhookService: BotWebhookService,
    private readonly botJobService: BotJobService,
    private readonly migrationService: MigrationService,
    private readonly verifyAndFixService: VerifyAndFixService,
    private readonly cvbService: CvbService,
    private readonly cvbProdMigrationService: CvbProdMigrationService,
    private readonly locationsService: LocationsService,
    private readonly configService: ConfigService,
  ) {}

  // ── References ──────────────────────────────────────────────────────────────

  @Post('seed-references')
  async seedReferences(@Body('environment') environment: string) {
    return this.pipelineService.seedReferenceData(environment);
  }

  // ── Sessions ────────────────────────────────────────────────────────────────

  @Post('sessions')
  async createSession(
    @Body() dto: CreateSeedingSessionDto,
    @Request() req: any,
  ) {
    const actor = req.user?.name || 'Operator';
    return this.sessionService.create({ ...dto, createdBy: actor });
  }

  @Post('sessions/import-scraper')
  @UseInterceptors(FilesInterceptor('files', 2))
  async importScraperData(
    @UploadedFiles() files: Express.Multer.File[],
    @Body()
    body: {
      name: string;
      environment: string;
      actor?: string;
      defaultIndustry?: string;
      defaultCategories?: string;
      defaultCity?: string;
      defaultState?: string;
    },
    @Request() req: any,
  ) {
    if (!files || files.length < 1) {
      throw new HttpException(
        'At least scraper data file is required',
        400,
      );
    }

    let scraperData: any[];
    let emailMap: any = {};

    try {
      const scraperFile =
        files.find(
          (f) =>
            f.originalname.includes('scraper') ||
            f.originalname.includes('data') ||
            f.fieldname === 'scraperData',
        ) || files[0];

      scraperData = JSON.parse(scraperFile.buffer.toString('utf-8'));

      const emailFile =
        files.find(
          (f) =>
            f.originalname.includes('email') ||
            f.fieldname === 'emailMap',
        ) || (files.length > 1 ? files[1] : null);

      if (emailFile && emailFile !== scraperFile) {
        emailMap = JSON.parse(emailFile.buffer.toString('utf-8'));
      }
    } catch (err: any) {
      throw new HttpException(`Invalid JSON: ${err.message}`, 400);
    }

    if (!Array.isArray(scraperData)) {
      throw new HttpException(
        'Scraper data must be a JSON array',
        400,
      );
    }

    let defaultCategories: string[] | undefined;
    if (body.defaultCategories) {
      try {
        const parsed = JSON.parse(body.defaultCategories);
        if (Array.isArray(parsed)) defaultCategories = parsed;
      } catch {
        defaultCategories = undefined;
      }
    }

    const locationsDocs = await this.locationsService.listActive();
    const locations = locationsDocs.map((d) => ({
      city: d.city,
      state: d.state,
      areas: (d.areas ?? []).map((a) => ({
        name: a.name,
        subRegion: a.subRegion,
        state: a.state,
      })),
      isActive: d.isActive,
    }));

    const result = adaptScraperData(scraperData, emailMap, {
      defaultIndustry: body.defaultIndustry,
      defaultCategories,
      defaultCity: body.defaultCity,
      defaultState: body.defaultState,
      locations,
    });

    const actor = req.user?.name || body.actor || 'Operator';

    const session = await this.sessionService.create({
      name:
        body.name ||
        `Scraper Import ${new Date().toISOString().slice(0, 10)}`,
      environment: body.environment || 'staging',
      modules: [SeedingModules.BUSINESS],
      createdBy: actor,
    });

    const sessionId = String(session._id);

    for (const record of result.records) {
      // Strip transient __warnings before persisting, then convert each
      // into a validationErrors entry with severity 'warning'. Warnings
      // do NOT fail the record — status stays TRANSFORMED.
      const warnings: string[] = Array.isArray((record as any).__warnings)
        ? (record as any).__warnings
        : [];
      const clean: any = { ...record };
      delete clean.__warnings;

      const validationErrors = warnings.map((message) => ({
        // Best-effort field attribution for the operator UI. State/area
        // keep top priority so the existing contradiction warnings (which
        // mention "coordinates" alongside "state") still map to 'state'.
        field: /state/i.test(message)
          ? 'state'
          : /area/i.test(message)
            ? 'area'
            : /placeId/i.test(message)
              ? 'placeId'
              : /coordinates|coords/i.test(message)
                ? 'coordinates'
                : /\bhours\b/i.test(message)
                  ? 'regularTiming'
                  : /address1|address/i.test(message)
                    ? 'address1'
                    : /\bname\b/i.test(message)
                      ? 'name'
                      : 'city',
        message,
        severity: 'warning',
      }));

      await this.recordService.create({
        sessionId,
        module: SeedingModules.BUSINESS,
        rawData: clean,
        transformedData: clean,
        status: SeedingRecordStatus.TRANSFORMED,
        ...(validationErrors.length > 0 ? { validationErrors } : {}),
      });
    }

    const dominant = computeDominant(
      result.records.map((r: any) => ({
        rawData: r,
        transformedData: r,
      })),
    );

    await this.sessionService.updateById(sessionId, {
      totalRecords: result.records.length,
      status: SeedingSessionStatus.TRANSFORMED,
      dominantCity: dominant.dominantCity,
      dominantState: dominant.dominantState,
      dominantIndustry: dominant.dominantIndustry,
      dominantCategory: dominant.dominantCategory,
    });

    await this.logService.log({
      sessionId,
      action: SeedingLogActions.SCRAPER_IMPORT,
      actor,
      message:
        `Scraper import: ${result.stats.processed} records ` +
        `(${result.stats.emailMatched} emails matched, ` +
        `${result.stats.noWebsite} no website, ` +
        `${result.stats.categoryFallback} category fallbacks, ` +
        `${result.stats.cityResolved} city resolved, ` +
        `${result.stats.cityDefaulted} city defaulted, ` +
        `${result.stats.cityUnresolved} city unresolved, ` +
        `${result.stats.areaInList} area in list, ` +
        `${result.stats.areaKeptCustom} area kept custom) ` +
        `| data quality: ${result.stats.hoursUnparsed} hours unparsed, ` +
        `${result.stats.addressInvalid} invalid address, ` +
        `${result.stats.noCoords} no coords, ` +
        `${result.stats.noPlaceId} no placeId, ` +
        `${result.stats.noName} no name`,
    });

    return {
      sessionId,
      stats: result.stats,
    };
  }

  @Get('sessions')
  async listSessions(
    @Query('environment') environment?: string,
    @Query('status') status?: string,
    @Query('createdBy') createdBy?: string,
  ) {
    return this.sessionService.findAll({ environment, status, createdBy });
  }

  @Get('sessions/:id')
  async getSession(@Param('id') id: string) {
    return this.sessionService.findById(id);
  }

  @Get('analytics/coverage')
  async getCoverageAnalytics(@Query('environment') environment?: string) {
    return this.sessionService.getCoverageAnalytics({ environment });
  }

  @Patch('sessions/:id/cancel')
  async cancelSession(@Param('id') id: string, @Body('actor') actor: string) {
    return this.sessionService.cancel(id, actor);
  }

  // ── Records ─────────────────────────────────────────────────────────────────

  @Post('sessions/:id/records')
  async uploadRecords(
    @Param('id') id: string,
    @Body() dto: BulkUploadRecordsDto,
  ) {
    const session = await this.sessionService.findById(id);
    const records = await this.recordService.bulkCreate(
      String(session._id),
      dto.module,
      dto.records,
    );
    await this.sessionService.updateStats(String(session._id));
    return { inserted: records.length };
  }

  @Get('sessions/:id/records')
  async getRecords(
    @Param('id') id: string,
    @Query('module') module?: string,
    @Query('status') status?: string,
  ) {
    const session = await this.sessionService.findById(id);
    return this.recordService.findBySession(String(session._id), {
      module,
      status,
    });
  }

  @Get('sessions/:id/records/full')
  async getSessionRecordsFull(
    @Param('id') id: string,
    @Query('module') module?: string,
    @Query('status') status?: string,
  ) {
    return this.recordService.findBySessionWithFullData(id, {
      module,
      status,
    });
  }

  @Get('sessions/:id/records/:rid/full')
  async getRecordFull(@Param('rid') rid: string) {
    return this.recordService.findByIdWithFullData(rid);
  }

  @Get('sessions/:id/records/:rid')
  async getRecord(@Param('rid') rid: string) {
    return this.recordService.findById(rid);
  }

  @Patch('records/:id')
  async updateRecord(
    @Param('id') id: string,
    @Body()
    body: {
      transformedData?: any;
      rawData?: any;
    },
  ) {
    const existing = await this.recordService.findById(id);
    const update: Record<string, any> = {};

    if (body.transformedData) {
      const incoming = { ...body.transformedData };
      delete incoming.industry;
      delete incoming.categories;
      const existingT = (existing.transformedData ?? {}) as Record<string, any>;
      update.transformedData = {
        ...incoming,
        industry: existingT.industry,
        categories: existingT.categories,
      };
    }
    if (body.rawData) {
      const incoming = { ...body.rawData };
      delete incoming.industry;
      delete incoming.categories;
      const existingR = (existing.rawData ?? {}) as Record<string, any>;
      update.rawData = {
        ...incoming,
        industry: existingR.industry,
        categories: existingR.categories,
      };
    }

    await this.recordService.updateRecord(id, update);
    const updated = await this.recordService.findById(id);

    return { message: 'Record updated', record: updated };
  }

  // ── Pipeline actions ────────────────────────────────────────────────────────

  @Post('sessions/:id/validate')
  async validate(@Param('id') id: string, @Request() req: any) {
    const actor = req.user?.name || 'Operator';
    await this.pipelineService.runValidation(id, actor);
    return { message: 'Validation complete' };
  }

  @Post('sessions/:id/transform')
  async transform(@Param('id') id: string, @Request() req: any) {
    const actor = req.user?.name || 'Operator';
    await this.pipelineService.runTransformation(id, actor);
    return { message: 'Transformation complete' };
  }

  @Post('sessions/:id/enrich')
  async enrich(@Param('id') id: string, @Request() req: any) {
    const actor = req.user?.name || 'Operator';
    await this.pipelineService.runEnrichment(id, actor);
    return { message: 'Enrichment complete' };
  }

  // Audit (and optionally auto-fix) already-seeded businesses in a previous
  // session against the current activation checklist. dryRun:true reports
  // only; dryRun:false applies the auto-fixable items. Returns a SESSION-LEVEL
  // aggregate (no per-business list).
  @Post('sessions/:id/verify-and-fix')
  async verifyAndFix(
    @Param('id') id: string,
    @Body() body: { dryRun?: boolean },
    @Request() req: any,
  ) {
    const actor = req.user?.name || 'Operator';
    return this.verifyAndFixService.run(id, {
      dryRun: body?.dryRun ?? true,
      actor,
    });
  }

  @Post('sessions/:id/re-enrich')
  async reEnrich(
    @Param('id') id: string,
    @Body('recordIds') recordIds: string[],
    @Request() req: any,
  ) {
    const actor = req.user?.name || 'Operator';
    const result = await this.pipelineService.reEnrich(
      id,
      recordIds ?? [],
      actor,
    );
    return { message: 'Re-enrichment complete', ...result };
  }

  @Post('sessions/:id/approve')
  async approve(@Param('id') id: string, @Request() req: any) {
    const actor = req.user?.name || 'Operator';
    await this.pipelineService.approveForPublishing(id, actor);
    return { message: 'Approved for publishing' };
  }

  @Roles(DopUserRole.ADMIN, DopUserRole.SUPER_ADMIN, DopUserRole.OPERATOR)
  @Post('sessions/:id/publish')
  async publish(
    @Param('id') id: string,
    @Body() _dto: PublishSessionDto,
    @Request() req: any,
  ) {
    const actor = req.user?.name || 'Operator';
    await this.pipelineService.publish(id, actor);
    return { message: 'Publishing complete' };
  }

  // ── Admin: Reset & Delete ────────────────────────────────────────────────────

  @Roles(DopUserRole.ADMIN, DopUserRole.SUPER_ADMIN)
  @Post('sessions/:id/reset')
  async resetSession(
    @Param('id') id: string,
    @Body('adminPassword') adminPassword: string,
    @Request() req: any,
  ) {
    const actor = req.user?.name || 'Operator';
    await this.pipelineService.resetSession(id, actor, adminPassword);
    return { message: 'Session reset to draft' };
  }

  @Post('sessions/:id/reset-bot')
  async resetBotStages(
    @Param('id') id: string,
    @Body()
    body: {
      stages: ('gallery' | 'menu' | 'reviews')[];
      environment: string;
    },
  ): Promise<{ message: string }> {
    await this.pipelineService.resetBotStages(
      id,
      body.stages,
      body.environment,
    );
    return {
      message: `Bot data reset for stages: ${body.stages.join(', ')}`,
    };
  }

  @Post('sessions/:id/assign-cover-as-logo')
  async assignCoverAsLogo(
    @Param('id') sessionId: string,
    @Body() body: { environment: string },
  ) {
    const uriKey = EnvironmentUriKey[
      body.environment as keyof typeof EnvironmentUriKey
    ];
    const targetUri = this.configService.get<string>(uriKey);
    if (!targetUri) {
      throw new HttpException('Invalid environment', 400);
    }

    const conn = mongoose.createConnection(targetUri);
    try {
      const BusinessModel =
        conn.models['Business'] ||
        conn.model(
          'Business',
          new mongoose.Schema({}, { strict: false }),
          'businesses',
        );

      const records = await this.recordService.findBySession(sessionId);

      const publishedIds = records
        .map((r) => (r as any).publishedId)
        .filter(Boolean)
        .map((id: string) => new mongoose.Types.ObjectId(id));

      if (publishedIds.length === 0) {
        return { updated: 0, message: 'No published businesses' };
      }

      const result = await BusinessModel.updateMany(
        {
          _id: { $in: publishedIds },
          cover: { $exists: true, $nin: [null, ''] },
          coverUploaded: true,
          $or: [
            { logo: { $exists: false } },
            { logo: null },
            { logo: '' },
            { logoUploaded: { $ne: true } },
            { logo: { $regex: GOOGLE_IMAGE_HOST_REGEX } },
          ],
        },
        [
          {
            $set: {
              logo: '$cover',
              logoUploaded: true,
              logoStatus: {
                fetched: true,
                source: 'cover',
                syncedAt: '$$NOW',
              },
            },
          },
        ],
      );

      this.logger.log(
        `[COVER→LOGO] Updated ${result.modifiedCount} ` +
          `businesses in session ${sessionId}`,
      );

      return {
        updated: result.modifiedCount,
        message: `Assigned cover as logo for ${result.modifiedCount} businesses`,
      };
    } finally {
      await conn.close();
    }
  }

  @Roles(DopUserRole.ADMIN, DopUserRole.SUPER_ADMIN)
  @Delete('sessions/:id')
  async deleteSession(
    @Param('id') id: string,
    @Body('adminPassword') adminPassword: string,
    @Request() req: any,
  ) {
    const actor = req.user?.name || 'Operator';
    await this.pipelineService.deleteSession(id, actor, adminPassword);
    return { message: 'Session deleted' };
  }

  // ── Logs & Stats ────────────────────────────────────────────────────────────

  @Get('sessions/:id/logs')
  async getLogs(@Param('id') id: string) {
    const session = await this.sessionService.findById(id);
    return this.logService.getSessionLogs(String(session._id));
  }

  @Get('sessions/:id/stats')
  async getStats(@Param('id') id: string) {
    const session = await this.sessionService.findById(id);
    return this.recordService.getStatusSummary(String(session._id));
  }

  // ── Bot webhook ─────────────────────────────────────────────────────────────

  @Public()
  @Post('bot/webhook')
  async botWebhook(
    @Body() payload: any,
    @Headers('x-bot-secret') secret: string,
  ): Promise<{ message: string }> {
    const expected = this.configService.get<string>('app.botWebhookSecret');
    if (expected && secret !== expected) {
      throw new HttpException('Unauthorized', 401);
    }
    await this.botWebhookService.handleWebhook(payload);
    return { message: 'Webhook received' };
  }

  @Public()
  @Post('bot/progress')
  async botProgress(
    @Body()
    body: {
      businessId: string;
      sessionId?: string;
      stage: string;
      action: string;
      current?: number;
      total?: number;
      detail?: string;
      folderName?: string;
      foldersTotal?: number;
    },
    @Headers('x-bot-secret') secret: string,
  ): Promise<{ ok: boolean }> {
    const expected = this.configService.get<string>('app.botWebhookSecret');
    if (expected && secret !== expected) {
      throw new HttpException('Unauthorized', 401);
    }

    const {
      businessId,
      stage,
      action,
      current,
      total,
      detail,
      folderName,
      foldersTotal,
    } = body;

    const update: Record<string, any> = {
      currentStage: stage,
      currentDetail: detail || '',
    };

    if (stage === 'gallery') {
      if (action === 'started') {
        update['progress.gallery.status'] = 'scraping';
        update['progress.gallery.foldersTotal'] = foldersTotal || 0;
      } else if (action === 'folder_started') {
        update['progress.gallery.currentFolder'] = folderName || '';
      } else if (action === 'folder_done') {
        update['progress.gallery.folders'] = current || 0;
        update['progress.gallery.images'] = total || 0;
        update['progress.gallery.currentFolder'] = folderName || '';
      } else if (action === 'done') {
        update['progress.gallery.status'] = 'done';
        update['progress.gallery.folders'] = current || 0;
        update['progress.gallery.images'] = total || 0;
        update['progress.gallery.currentFolder'] = null;
        update['galleryFolders'] = current || 0;
        update['galleryImages'] = total || 0;
      }
    } else if (stage === 'menu') {
      if (action === 'started') {
        update['progress.menu.status'] = 'scraping';
      } else if (action === 'done') {
        update['progress.menu.status'] = 'done';
        update['progress.menu.items'] = current || 0;
        update['menuItems'] = current || 0;
      }
    } else if (stage === 'reviews') {
      if (action === 'started') {
        update['progress.reviews.status'] = 'scraping';
        update['progress.reviews.total'] = total || 0;
        update['progress.reviews.current'] = 0;
      } else if (action === 'scrolling') {
        update['progress.reviews.current'] = current || 0;
        update['progress.reviews.total'] = total || 0;
      } else if (action === 'expanding') {
        update['progress.reviews.expanding'] = current || 0;
      } else if (action === 'parsing') {
        update['progress.reviews.current'] = current || 0;
      } else if (action === 'done') {
        update['progress.reviews.status'] = 'done';
        update['progress.reviews.current'] = current || 0;
        update['progress.reviews.total'] = current || 0;
        update['reviewCount'] = current || 0;
      }
    }

    await this.recordService.updateBotProgress(businessId, update);

    return { ok: true };
  }

  @Get('sessions/:id/bot-status')
  async getBotStatus(@Param('id') id: string) {
    return this.recordService.getBotScrapeStatuses(id);
  }

  // ── Migration ───────────────────────────────────────────────────────────────

  @Post('sessions/:id/check-migration')
  async checkMigration(
    @Param('id') id: string,
    @Body()
    body: {
      targetEnvironment: string;
      recordIds?: string[];
    },
  ) {
    return this.migrationService.checkConflicts({
      sourceSessionId: id,
      targetEnvironment: body.targetEnvironment,
      recordIds: body.recordIds,
    });
  }

  @Roles(DopUserRole.ADMIN, DopUserRole.SUPER_ADMIN)
  @Post('sessions/:id/migrate')
  async migrateSession(
    @Param('id') id: string,
    @Body()
    body: {
      targetEnvironment: string;
      recordIds?: string[];
      conflictResolution: Record<string, 'skip' | 'overwrite'>;
    },
    @Request() req: any,
  ) {
    const actor = req.user?.name || 'Operator';
    return this.migrationService.migrate({
      sourceSessionId: id,
      targetEnvironment: body.targetEnvironment,
      actor,
      recordIds: body.recordIds,
      conflictResolution: body.conflictResolution,
    });
  }

  @Roles(DopUserRole.ADMIN, DopUserRole.SUPER_ADMIN, DopUserRole.OPERATOR)
  @Post('sessions/:id/trigger-bot')
  async triggerBotScrape(
    @Param('id') id: string,
    @Body()
    body: {
      records: {
        placeId: string;
        businessId: string;
        businessName: string;
        environment: string;
        maxReviews?: number;
      }[];
      skipReviews?: boolean;
      skipGallery?: boolean;
      skipMenu?: boolean;
      type?: 'gallery_menu' | 'reviews' | 'image_sync' | 'cover_sync';
    },
  ): Promise<{ created: number }> {
    const type =
      (body.type as BotJobType | undefined) ??
      (body.skipReviews === false && body.skipGallery === true
        ? BotJobType.REVIEWS
        : BotJobType.GALLERY_MENU);

    return this.botJobService.createJobs({
      records: body.records ?? [],
      sessionId: id,
      type,
    });
  }

  @Public()
  @Get('bot/poll')
  async pollJob(
    @Query('type') type?: string,
    @Headers('x-bot-secret') secret?: string,
  ) {
    const expected = this.configService.get<string>('app.botWebhookSecret');
    if (secret !== expected) {
      throw new HttpException('Unauthorized', 403);
    }

    await this.botJobService.resetStuckJobs();

    const jobType = type as BotJobType | undefined;
    // resolve_business is served exclusively via /bot/poll-batch so the
    // parallel worker pool owns it. The single-job loop polling here
    // must never grab a resolve job (which would defeat the pool).
    const job = await this.botJobService.claimNextJob(
      jobType,
      jobType ? undefined : [BotJobType.RESOLVE_BUSINESS],
    );

    if (!job) {
      return { job: null };
    }

    return { job };
  }

  // Batch claim endpoint for the resolve_business parallel pool only.
  // Atomically claims up to `limit` pending jobs of the given type.
  @Public()
  @Get('bot/poll-batch')
  async pollJobBatch(
    @Query('type') type?: string,
    @Query('limit') limit?: string,
    @Headers('x-bot-secret') secret?: string,
  ) {
    const expected = this.configService.get<string>('app.botWebhookSecret');
    if (secret !== expected) {
      throw new HttpException('Unauthorized', 403);
    }

    if (!type) {
      throw new HttpException('type query param is required', 400);
    }

    await this.botJobService.resetStuckJobs();

    const n = limit ? parseInt(limit, 10) : 1;
    const jobs = await this.botJobService.claimNextJobs(
      type as BotJobType,
      Number.isFinite(n) && n > 0 ? n : 1,
    );

    return { jobs };
  }

  @Public()
  @Post('bot/job/:id/complete')
  async completeBotJob(
    @Param('id') id: string,
    @Body() body: { success: boolean; error?: string },
    @Headers('x-bot-secret') secret?: string,
  ) {
    const expected = this.configService.get<string>('app.botWebhookSecret');
    if (secret !== expected) {
      throw new HttpException('Unauthorized', 403);
    }

    await this.botJobService.completeJob(id, body);
    return { message: 'Job updated' };
  }

  @Get('sessions/:id/bot-jobs')
  async getSessionBotJobs(@Param('id') id: string) {
    return this.botJobService.getSessionJobStats(id);
  }

  @Get('sessions/:id/bot-jobs/active')
  async getSessionActiveBotJobs(@Param('id') id: string) {
    return this.botJobService.getActiveSessionJobs(id);
  }

  // ── CVB ─────────────────────────────────────────────────────────────────────

  @Get('cvb/businesses')
  async getCvbBusinesses(
    @Query('city') city?: string,
    @Query('state') state?: string,
    @Query('industry') industry?: string,
    @Query('category') category?: string,
    @Query('search') search?: string,
    @Query('hasPlaceId') hasPlaceId?: string,
    @Query('hasMissingFields') hasMissingFields?: string,
    @Query('sortBy') sortBy?: 'newest' | 'oldest' | 'name',
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.cvbService.queryCvbBusinesses({
      city,
      state,
      industry,
      category,
      search,
      hasPlaceId:
        hasPlaceId === 'true'
          ? true
          : hasPlaceId === 'false'
            ? false
            : undefined,
      hasMissingFields: hasMissingFields === 'true',
      sortBy,
      page: page ? parseInt(page) : 1,
      limit: limit ? parseInt(limit) : 20,
    });
  }

  @Get('cvb/filters')
  async getCvbFilters() {
    return this.cvbService.getCvbFilters();
  }

  @Post('sessions/:id/import-cvb')
  async importCvb(
    @Param('id') id: string,
    @Body() body: { businessIds: string[] },
    @Request() req: any,
  ) {
    const actor = req.user?.name || 'Operator';
    return this.cvbService.importCvbBusinesses({
      sessionId: id,
      businessIds: body.businessIds,
      actor,
    });
  }

  @Post('sessions/:id/cvb-validate')
  async cvbValidate(@Param('id') id: string, @Request() req: any) {
    const actor = req.user?.name || 'Operator';
    return this.cvbService.validateCvbSession({
      sessionId: id,
      actor,
    });
  }

  @Post('sessions/:id/cvb-autofix')
  async cvbAutoFix(@Param('id') id: string, @Request() req: any) {
    const actor = req.user?.name || 'Operator';
    return this.cvbService.autoFixSession({
      sessionId: id,
      actor,
    });
  }

  @Post('records/:id/cvb-apply-fix')
  async cvbApplyFix(
    @Param('id') id: string,
    @Body()
    body: {
      field: string;
      value: any;
      mode: 'manual' | 'auto';
    },
    @Request() req: any,
  ) {
    const actor = req.user?.name || 'Operator';
    return this.cvbService.applyFix({
      recordId: id,
      field: body.field,
      value: body.value,
      actor,
      mode: body.mode || 'manual',
    });
  }

  @Post('records/:id/cvb-reject-fix')
  async cvbRejectFix(
    @Param('id') id: string,
    @Body() body: { field: string },
    @Request() req: any,
  ) {
    const actor = req.user?.name || 'Operator';
    return this.cvbService.rejectFix({
      recordId: id,
      field: body.field,
      actor,
    });
  }

  // ── CVB → PROD migration ────────────────────────────────────────────────────

  @Roles(DopUserRole.ADMIN, DopUserRole.SUPER_ADMIN)
  @Get('cvb-migration/not-in-prod')
  async cvbMigrationNotInProd(
    @Query('city') city?: string,
    @Query('state') state?: string,
    @Query('industry') industry?: string,
    @Query('category') category?: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.cvbProdMigrationService.listNotInProd({
      city,
      state,
      industry,
      category,
      search,
      page: page ? parseInt(page) : 1,
      limit: limit ? parseInt(limit) : 20,
    });
  }

  @Roles(DopUserRole.ADMIN, DopUserRole.SUPER_ADMIN)
  @Post('cvb-migration/migrate')
  async cvbMigrationMigrate(
    @Body()
    body: {
      businessIds?: string[];
      filters?: {
        city?: string;
        state?: string;
        industry?: string;
        category?: string;
        search?: string;
      };
      dryRun: boolean;
    },
    @Request() req: any,
  ) {
    const actor = req.user?.name || 'Admin';
    return this.cvbProdMigrationService.migrateToProd({
      businessIds: body.businessIds,
      filters: body.filters,
      dryRun: body.dryRun !== false, // default safe — dry unless explicitly false
      actor,
    });
  }
}
