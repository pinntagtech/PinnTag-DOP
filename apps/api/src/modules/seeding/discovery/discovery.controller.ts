import {
  Body,
  Controller,
  Get,
  Headers,
  HttpException,
  Logger,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Public } from '../../auth/decorators/public.decorator';
import { DiscoveryService } from './discovery.service';
import { JudgmentService } from '../judgment/judgment.service';
import { JudgeInput } from '../judgment/types';
import { DiscoveryRunService } from './discovery-run.service';
import { BotJob, BotJobDocument, BotJobStatus } from '../schemas/bot-job.schema';

@Controller('seeding/discovery')
export class DiscoveryController {
  private readonly logger = new Logger(DiscoveryController.name);

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly judgment: JudgmentService,
    private readonly runService: DiscoveryRunService,
    private readonly configService: ConfigService,
    @InjectModel(BotJob.name)
    private readonly botJobModel: Model<BotJobDocument>,
  ) {}

  // Idempotent upsert of the shipped region set. Safe to call repeatedly;
  // only fills gaps and refreshes bbox/priority. Never resets runtime
  // status/stats. Not gated behind admin password — the region set is
  // hardcoded in region-seed-data.ts, this endpoint only projects it.
  @Post('regions/seed')
  async seedRegions() {
    return this.discovery.seedRegions();
  }

  // Phase 1 dry-run preview. No writes to staging. Mirrors the shape of
  // /seeding/migration/gated/preview so operators have one mental model.
  @Post('regions/:regionId/preview')
  async preview(@Param('regionId') regionId: string) {
    try {
      return await this.discovery.previewRegion(regionId);
    } catch (e) {
      if (e instanceof HttpException) throw e;
      const msg = (e as Error).message ?? String(e);
      this.logger.error(`preview ${regionId} failed: ${msg}`);
      throw new HttpException(msg, 500);
    }
  }

  // Phase 2 hand-picked sample: category-filter, stride-pick `limit`
  // candidates, resolve each via Places API v1 :searchText, and re-dedup
  // resolved placeIds against staging + prod. No writes.
  @Post('regions/:regionId/resolve-sample')
  async resolveSample(
    @Param('regionId') regionId: string,
    @Query('limit') limitStr?: string,
  ) {
    const limit = Math.min(Math.max(1, Number(limitStr ?? 15) || 15), 50);
    try {
      return await this.discovery.resolveSample(regionId, limit);
    } catch (e) {
      if (e instanceof HttpException) throw e;
      const msg = (e as Error).message ?? String(e);
      this.logger.error(`resolveSample ${regionId} failed: ${msg}`);
      throw new HttpException(msg, 500);
    }
  }

  // Phase 3 dry-run: runs the Phase 2 resolveSample pipeline, then runs
  // every RESOLVED candidate (non-null Places result) through the judgment
  // layer. Zero-result rows are excluded from the judgment pass — there's
  // nothing to judge without a Google identity. No DB writes.
  @Post('regions/:regionId/judge-sample')
  async judgeSample(
    @Param('regionId') regionId: string,
    @Query('limit') limitStr?: string,
  ) {
    const limit = Math.min(Math.max(1, Number(limitStr ?? 50) || 50), 50);
    try {
      const resolveResult = await this.discovery.resolveSample(regionId, limit);
      // Only the resolved population goes through judgment.
      const judgeInputs: JudgeInput[] = resolveResult.sample
        .filter((s) => s.resolved !== null)
        .map((s) => ({
          overture: s.overture,
          resolved: s.resolved,
          dedup: s.dedup,
        }));
      const judgments = await this.judgment.judgeMany(judgeInputs);

      // Re-attach judgments to the corresponding sample rows (by index
      // into the resolved subset). Zero-result rows carry `judgment:null`.
      let jIdx = 0;
      const augmentedSample = resolveResult.sample.map((s) => {
        if (s.resolved === null) return { ...s, judgment: null };
        return { ...s, judgment: judgments[jIdx++] };
      });

      // Aggregate rollups for the report.
      const rollup = {
        judgedCount: judgments.length,
        needsReview: judgments.filter((j) => j.needsReview).length,
        // Per-judge review counts — lets an operator see which judge is
        // dominating the review queue without unpacking every record.
        needsReviewByJudge: {
          category: judgments.filter((j) => j.needsReviewByJudge.category)
            .length,
          city: judgments.filter((j) => j.needsReviewByJudge.city).length,
          anomaly: judgments.filter((j) => j.needsReviewByJudge.anomaly)
            .length,
          onlyCategory: judgments.filter(
            (j) =>
              j.needsReviewByJudge.category &&
              !j.needsReviewByJudge.city &&
              !j.needsReviewByJudge.anomaly,
          ).length,
          onlyCity: judgments.filter(
            (j) =>
              !j.needsReviewByJudge.category &&
              j.needsReviewByJudge.city &&
              !j.needsReviewByJudge.anomaly,
          ).length,
          onlyAnomaly: judgments.filter(
            (j) =>
              !j.needsReviewByJudge.category &&
              !j.needsReviewByJudge.city &&
              j.needsReviewByJudge.anomaly,
          ).length,
          multiple: judgments.filter((j) => {
            const b = j.needsReviewByJudge;
            const n = (b.category ? 1 : 0) + (b.city ? 1 : 0) + (b.anomaly ? 1 : 0);
            return n >= 2;
          }).length,
          none: judgments.filter(
            (j) =>
              !j.needsReviewByJudge.category &&
              !j.needsReviewByJudge.city &&
              !j.needsReviewByJudge.anomaly,
          ).length,
        },
        acceptedGoogle: judgments.filter(
          (j) => j.anomaly.decision.action === 'accept_google',
        ).length,
        skipped: judgments.filter(
          (j) => j.anomaly.decision.action === 'skip',
        ).length,
        review: judgments.filter(
          (j) => j.anomaly.decision.action === 'needs_review',
        ).length,
//        categorySource: {
//        rule: judgments.filter((j) => j.category.source === 'rule').length,
//          claude: judgments.filter((j) => j.category.source === 'claude-api')
//            .length,
//        },
//        citySource: {
//          rule: judgments.filter((j) => j.city.source === 'rule').length,
//          claude: judgments.filter((j) => j.city.source === 'claude-api')
//            .length,
//        },
//        anomalySource: {
//          rule: judgments.filter((j) => j.anomaly.source === 'rule').length,
//          claude: judgments.filter((j) => j.anomaly.source === 'claude-api')
//           .length,
//        },
categorySource: {
          rule: judgments.filter((j) => j.category.source === 'rule').length,
          localLlm: judgments.filter(
            (j) => j.category.source === 'local-llm',
          ).length,
          claude: judgments.filter((j) => j.category.source === 'claude-api')
            .length,
        },
        citySource: {
          rule: judgments.filter((j) => j.city.source === 'rule').length,
          localLlm: judgments.filter((j) => j.city.source === 'local-llm')
            .length,
          claude: judgments.filter((j) => j.city.source === 'claude-api')
            .length,
        },
        anomalySource: {
          rule: judgments.filter((j) => j.anomaly.source === 'rule').length,
          localLlm: judgments.filter(
            (j) => j.anomaly.source === 'local-llm',
          ).length,
          claude: judgments.filter((j) => j.anomaly.source === 'claude-api')
            .length,
        },
      };

      return {
        region: resolveResult.region,
        resolveSummary: resolveResult.resolveSummary,
        rollup,
        sample: augmentedSample,
      };
    } catch (e) {
      if (e instanceof HttpException) throw e;
      const msg = (e as Error).message ?? String(e);
      this.logger.error(`judgeSample ${regionId} failed: ${msg}`);
      throw new HttpException(msg, 500);
    }
  }

  // Phase 4 pilot-batch runner. Kicks off a background run and returns
  // the runId immediately — poll GET /seeding/discovery/runs/:runId for
  // progress. Real writes to staging.businesses (draft state, invisible
  // to consumer app via the isActive+outlet gate).
  //
  // Guarded by adminPassword to match the CVB / dedup endpoint pattern
  // — a large paid run shouldn't be one accidental curl away.
  @Post('regions/:regionId/run-batch')
  async runBatch(
    @Param('regionId') regionId: string,
    @Body()
    body: {
      limit?: number;
      parallelism?: number;
      minOvertureConfidence?: number;
      adminPassword?: string;
    },
  ) {
    const configured = process.env.DOP_ADMIN_PASSWORD;
    if (!configured || body.adminPassword !== configured) {
      throw new HttpException('Invalid admin password', 403);
    }
    const limit = Math.min(Math.max(1, Number(body.limit ?? 100) || 100), 5000);
    const parallelism = Math.min(
      Math.max(1, Number(body.parallelism ?? 10) || 10),
      20,
    );
    const minOvertureConfidence = Math.max(
      0,
      Math.min(1, Number(body.minOvertureConfidence ?? 0.6) || 0.6),
    );
    try {
      const runId = await this.runService.startRun({
        regionId,
        limit,
        parallelism,
        minOvertureConfidence,
      });
      return {
        runId,
        regionId,
        params: { limit, parallelism, minOvertureConfidence },
        status: 'running',
        pollAt: `/api/v1/seeding/discovery/runs/${runId}`,
      };
    } catch (e) {
      if (e instanceof HttpException) throw e;
      const msg = (e as Error).message ?? String(e);
      this.logger.error(`runBatch ${regionId} failed to start: ${msg}`);
      throw new HttpException(msg, 500);
    }
  }

  @Get('runs/:runId')
  async getRun(@Param('runId') runId: string) {
    const run = await this.runService.getRun(runId);
    if (!run) throw new HttpException(`No run: ${runId}`, 404);
    return run;
  }

  // One-off recovery endpoint: re-judge the needsReview cohort for a
  // specific run using stored doc data + a re-pulled Overture map. Built
  // to recover the atlanta-ga run that dumped ~1449 records into review
  // as "Ollama call failed" placeholders while the GPU was down. Dry-run
  // by default; pass dryRun=false to actually write llmJudgment /
  // needsReview / needsReviewByJudge back to each doc.
  @Post('re-judge-run')
  async reJudgeRun(
    @Body()
    body: {
      runId: string;
      dryRun?: boolean;
      limit?: number;
      parallelism?: number;
      scope?: 'review' | 'all';
      // Optional narrowing filter — restrict re-judgment to docs whose
      // seedProvenance.overtureCategory matches one of these values.
      overtureCategories?: string[];
      // Pass the previous call's passId to resume an interrupted sweep;
      // omit to start a fresh pass.
      passId?: string;
      adminPassword?: string;
    },
  ) {
    const configured = process.env.DOP_ADMIN_PASSWORD;
    if (!configured || body.adminPassword !== configured) {
      throw new HttpException('Invalid admin password', 403);
    }
    if (!body.runId) throw new HttpException('runId required', 400);
    const dryRun = body.dryRun !== false; // default true
    const scope = body.scope === 'all' ? 'all' : 'review';
    try {
      return await this.runService.reJudgeRun({
        runId: body.runId,
        dryRun,
        limit: body.limit,
        parallelism: body.parallelism,
        scope,
        overtureCategories: body.overtureCategories,
        passId: body.passId,
      });
    } catch (e) {
      if (e instanceof HttpException) throw e;
      const msg = (e as Error).message ?? String(e);
      this.logger.error(`reJudgeRun ${body.runId} failed: ${msg}`);
      throw new HttpException(msg, 500);
    }
  }

  // One-off recovery endpoint: consume DONE-but-unconsumed
  // DISCOVERY_SEARCH bot jobs for a given runId, drive them through the
  // downstream pipeline (judge → insert → discoveryProcessed), and mark
  // each job consumed. Built to recover orphan runs where executeRun
  // errored out before draining the bot pool. Idempotent — a second
  // call on the same runId processes 0 jobs.
  @Post('consume-run')
  async consumeRun(
    @Body()
    body: {
      runId: string;
      parallelism?: number;
      finalizeRunStatus?: boolean;
      adminPassword?: string;
    },
  ) {
    const configured = process.env.DOP_ADMIN_PASSWORD;
    if (!configured || body.adminPassword !== configured) {
      throw new HttpException('Invalid admin password', 403);
    }
    if (!body.runId) throw new HttpException('runId required', 400);
    try {
      return await this.runService.consumeBotResults({
        runId: body.runId,
        parallelism: body.parallelism,
        finalizeRunStatus: body.finalizeRunStatus,
      });
    } catch (e) {
      if (e instanceof HttpException) throw e;
      const msg = (e as Error).message ?? String(e);
      this.logger.error(`consumeRun ${body.runId} failed: ${msg}`);
      throw new HttpException(msg, 500);
    }
  }

  // ── Bot result webhook for DISCOVERY_SEARCH jobs ──────────────────────
  //
  // The discovery bot POSTs the resolved Google Maps match (or an error)
  // here after handling one discovery_search job. We persist the result
  // onto the job doc — the run orchestrator polls dopBotJobs for
  // terminal jobs on its runId and drives the downstream judge/insert
  // pipeline. No Business exists yet at this point; creating one is
  // downstream of judgment.
  //
  // Public + x-bot-secret guarded inline, matching the pattern used by
  // /seeding/resolve-business/webhook and /seeding/bot/webhook.
  @Public()
  @Post('bot-result')
  async botResult(
    @Body()
    payload: {
      jobId: string;
      result?: {
        placeId: string;
        name: string;
        formattedAddress: string;
        lat: number;
        lng: number;
      } | null;
      error?: string;
    },
    @Headers('x-bot-secret') secret: string,
  ): Promise<{ ok: true }> {
    const expected = this.configService.get<string>('app.botWebhookSecret');
    if (expected && secret !== expected) {
      throw new HttpException('Unauthorized', 401);
    }
    if (!payload || !payload.jobId) {
      throw new HttpException('jobId is required', 400);
    }

    const update: Record<string, any> = {};
    if (payload.result && payload.result.placeId) {
      update.discoveryResult = {
        placeId: String(payload.result.placeId),
        name: String(payload.result.name ?? ''),
        formattedAddress: String(payload.result.formattedAddress ?? ''),
        lat: Number(payload.result.lat),
        lng: Number(payload.result.lng),
      };
      update.discoveryError = '';
    } else {
      update.discoveryResult = null;
      // Preserve the reason so the orchestrator can distinguish
      // "bot said no match" from "not yet processed". Empty string
      // stays "unknown"; any non-empty value overrides.
      update.discoveryError = String(payload.error || 'no_match');
    }
    update.status = BotJobStatus.DONE;
    update.completedAt = new Date();

    await this.botJobModel.updateOne({ _id: payload.jobId }, { $set: update });
    return { ok: true };
  }
}
