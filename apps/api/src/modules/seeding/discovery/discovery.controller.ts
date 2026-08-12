import {
  Controller,
  HttpException,
  Logger,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { DiscoveryService } from './discovery.service';
import { JudgmentService } from '../judgment/judgment.service';
import { JudgeInput } from '../judgment/types';

@Controller('seeding/discovery')
export class DiscoveryController {
  private readonly logger = new Logger(DiscoveryController.name);

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly judgment: JudgmentService,
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
        categorySource: {
          rule: judgments.filter((j) => j.category.source === 'rule').length,
          claude: judgments.filter((j) => j.category.source === 'claude-api')
            .length,
        },
        citySource: {
          rule: judgments.filter((j) => j.city.source === 'rule').length,
          claude: judgments.filter((j) => j.city.source === 'claude-api')
            .length,
        },
        anomalySource: {
          rule: judgments.filter((j) => j.anomaly.source === 'rule').length,
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
}
