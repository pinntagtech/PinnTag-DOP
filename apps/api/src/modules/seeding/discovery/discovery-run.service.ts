// Phase 4 orchestrator. Takes a region + limit + parallelism + Overture
// confidence threshold, runs the full pipeline (Overture pull → geo
// dedup → category filter → confidence filter → skip-already-processed
// → Places resolve → judgment → insert/log) with resumable state.
//
// Runs asynchronously — the controller returns runId immediately and
// this class updates discoveryRuns + discoveryProcessed as work
// progresses. Crash-safe: on retry with the same regionId, previously-
// processed overtureSourceIds are skipped up front.

import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import mongoose, { Model } from 'mongoose';
import { randomUUID } from 'crypto';
import {
  DiscoveryRegion,
  DiscoveryRegionDocument,
} from './schemas/discovery-region.schema';
import {
  DiscoveryRun,
  DiscoveryRunDocument,
  DiscoveryRunStatus,
} from './schemas/discovery-run.schema';
import {
  DiscoveryProcessed,
  DiscoveryProcessedDocument,
  DiscoveryFinalAction,
} from './schemas/discovery-processed.schema';
import {
  fetchOverturePlacesInBbox,
  OvertureCandidate,
} from './overture-client';
import { buildSeededFilter } from '../common/seeded-cohort';
import {
  haversineMeters,
  metersToLatDeg,
  metersToLngDeg,
  nameSimilarity,
  normalizeName,
} from './dedup-helpers';
import { isBlockedOvertureCategory } from './category-blocklist';
import { JudgmentService } from '../judgment/judgment.service';
import { ClaudeClient } from '../judgment/claude-client';
import {
  insertBusinessOn,
  openStagingConnection,
} from './business-insert';
import { resolvePlaceIdBySearchText } from './places-client';
import { BotJobService } from '../bot/bot-job.service';
import { BotJobType } from '../schemas/bot-job.schema';
import { DriveActivationService } from '../activation/drive-activation.service';

const DEDUP_RADIUS_M = 50;
const NAME_SIM_THRESHOLD = 0.85;
const MATCH_CONFIRM_MAX_DIST_M = 200;
const MATCH_CONFIRM_MIN_NAME_SIM = 0.7;

export interface RunBatchParams {
  regionId: string;
  limit: number;
  parallelism: number;
  minOvertureConfidence: number;
}

@Injectable()
export class DiscoveryRunService {
  private readonly logger = new Logger(DiscoveryRunService.name);

  constructor(
    @InjectModel(DiscoveryRegion.name)
    private readonly regionModel: Model<DiscoveryRegionDocument>,
    @InjectModel(DiscoveryRun.name)
    private readonly runModel: Model<DiscoveryRunDocument>,
    @InjectModel(DiscoveryProcessed.name)
    private readonly processedModel: Model<DiscoveryProcessedDocument>,
    private readonly configService: ConfigService,
    private readonly judgment: JudgmentService,
    private readonly claude: ClaudeClient,
    private readonly botJobService: BotJobService,
  ) {}

  // Kick off a run in the background. Returns the runId immediately —
  // caller polls GET /seeding/discovery/runs/:runId for status.
  async startRun(params: RunBatchParams): Promise<string> {
    const region = await this.regionModel.findOne({ regionId: params.regionId }).lean();
    if (!region) throw new Error(`No region: ${params.regionId}`);

    const runId = `run_${Date.now()}_${randomUUID().slice(0, 8)}`;
    await this.runModel.create({
      runId,
      regionId: params.regionId,
      status: DiscoveryRunStatus.RUNNING,
      params: {
        limit: params.limit,
        parallelism: params.parallelism,
        minOvertureConfidence: params.minOvertureConfidence,
      },
      stats: {},
      startedAt: new Date(),
    });

    // Fire-and-forget. We deliberately don't await — errors are
    // captured onto the run doc via markFailed. Node's unhandled-
    // rejection would surface via pm2 logs anyway.
    this.executeRun(runId, params, region).catch((err) => {
      this.logger.error(
        `run ${runId} failed: ${(err as Error).message ?? err}`,
      );
      this.markFailed(runId, (err as Error).message ?? String(err));
    });
    return runId;
  }

  private async executeRun(
    runId: string,
    params: RunBatchParams,
    region: any,
  ): Promise<void> {
    const t0 = Date.now();
    this.claude.resetUsage();
    const startingUsage = this.claude.getUsage(); // 0's

    const bbox = {
      west: region.bbox.west,
      south: region.bbox.south,
      east: region.bbox.east,
      north: region.bbox.north,
    };

    // 1. Overture pull.
    const candidates = await fetchOverturePlacesInBbox(bbox);
    this.logger.log(`[${runId}] overture rows: ${candidates.length}`);

    // 2. Category filter (blocklist + null-cat drop).
    const catFiltered: OvertureCandidate[] = [];
    for (const c of candidates) {
      if (!c.overtureCategory) continue;
      if (isBlockedOvertureCategory(c.overtureCategory)) continue;
      catFiltered.push(c);
    }
    this.logger.log(`[${runId}] post-category: ${catFiltered.length}`);

    // 3. Confidence filter — cheap way to cut the noisy tail before
    // we spend Places calls on it. null-confidence rows are dropped
    // conservatively (rare — <1% of Overture places).
    const confFiltered = catFiltered.filter(
      (c) => c.confidence !== null && c.confidence >= params.minOvertureConfidence,
    );
    this.logger.log(
      `[${runId}] post-confidence(>=${params.minOvertureConfidence}): ${confFiltered.length}`,
    );

    // 4. Geo dedup pass 1 — same 50m + normalized-name Levenshtein
    // filter as the earlier phases, so we don't spend a Places call
    // on candidates that already sit next to a seeded business.
    const seeded = await this.loadSeededInBbox(bbox);
    const centerLat = (bbox.south + bbox.north) / 2;
    const { newCandidates } = this.dedupPass1(confFiltered, seeded, centerLat);
    this.logger.log(
      `[${runId}] post-geodedup: ${newCandidates.length} new (of ${confFiltered.length})`,
    );

    // 5. Skip-already-processed (resumable). Load the set of
    // overtureSourceIds ever handled for this regionId (any prior run,
    // any final action) and drop them from the queue.
    const alreadyProcessed = await this.loadProcessedSourceIds(params.regionId);
    const queue = newCandidates.filter(
      (c) => !alreadyProcessed.has(c.sourceId),
    );
    this.logger.log(
      `[${runId}] post-resume-skip: ${queue.length} (removed ${newCandidates.length - queue.length} already processed)`,
    );

    // 6. Sort by sourceId for deterministic, resumable ordering, then
    // trim to `limit`.
    queue.sort((a, b) => a.sourceId.localeCompare(b.sourceId));
    const toProcess = queue.slice(0, params.limit);
    this.logger.log(
      `[${runId}] taking limit=${params.limit}: ${toProcess.length} in this run`,
    );

    // 7. Resolve each candidate directly via Google Places searchText,
    //    same 500m rectangle as discovery.service.ts:resolveSample. The
    //    bot-side DISCOVERY_SEARCH path was reverted: no bot handler
    //    exists for it in apps/bot/main.py and the bot isn't running,
    //    so enqueueing bot jobs was silently doing nothing. Real Places
    //    API cost applies again for this endpoint.
    const stagingUri = this.configService.get<string>('database.pinntagStaging');
    if (!stagingUri) throw new Error('No URI for pinntagStaging');

    if (toProcess.length === 0) {
      // Nothing to do — write terminal stats and return.
      await this.runModel.updateOne(
        { runId },
        {
          $set: {
            status: DiscoveryRunStatus.COMPLETED,
            completedAt: new Date(),
            'stats.processed': 0,
            'stats.placesCallsTotal': 0,
          },
        },
      );
      this.logger.log(`[${runId}] nothing to process`);
      return;
    }

    const apiKey = this.configService.get<string>('app.googleApiKey') ?? '';
    if (!apiKey) throw new Error('GOOGLE_MAPS_API_KEY not set');

    const stagingConn = await openStagingConnection(stagingUri);
    try {
      let placesCallsTotal = 0;
      let placesZeroResult = 0;
      let actionAccept = 0;
      let actionReview = 0;
      let actionSkip = 0;
      let actionNotApplicable = 0;
      let actionZeroResult = 0;
      let errorCount = 0;
      let processed = 0;

      const processOne = async (c: OvertureCandidate): Promise<void> => {
        try {
          placesCallsTotal++;
          const resolved = await resolvePlaceIdBySearchText(
            {
              name: c.name,
              address: c.address,
              lat: c.lat,
              lng: c.lng,
              boxHalfSideMeters: 250,
            },
            apiKey,
          );
          if (!resolved) {
            placesZeroResult++;
            actionZeroResult++;
            await this.logProcessed(runId, params.regionId, c.sourceId, {
              action: 'zero_result',
              businessId: null,
              resolvedPlaceId: null,
              reasoning: 'places_zero_result',
            });
            return;
          }

          const dist = haversineMeters(c.lat, c.lng, resolved.lat, resolved.lng);
          const sim = nameSimilarity(normalizeName(c.name), normalizeName(resolved.name));
          const matchConfirmed =
            dist <= MATCH_CONFIRM_MAX_DIST_M && sim >= MATCH_CONFIRM_MIN_NAME_SIM;
          const matchReason = `name_sim=${sim.toFixed(2)} dist=${dist.toFixed(0)}m`;

          const existsInStaging = await this.placeIdExistsInStaging(
            stagingConn,
            resolved.placeId,
          );

          const judgment = await this.judgment.judgeRecord({
            overture: {
              name: c.name,
              address: c.address,
              lat: c.lat,
              lng: c.lng,
              category: c.overtureCategory,
              sourceId: c.sourceId,
            },
            resolved: {
              placeId: resolved.placeId,
              name: resolved.name,
              formattedAddress: resolved.formattedAddress,
              lat: resolved.lat,
              lng: resolved.lng,
              matchConfirmed,
              matchReason,
            },
            dedup: {
              existsInStaging: !!existsInStaging,
              existsInProd: false, // deferred to reconciliation
              stagingIsSeeded: existsInStaging ? existsInStaging.isSeeded : null,
              prodIsSeeded: null,
            },
          });

          if (judgment.finalAction === 'skip') {
            actionSkip++;
            await this.logProcessed(runId, params.regionId, c.sourceId, {
              action: 'skip',
              businessId: null,
              resolvedPlaceId: resolved.placeId,
              reasoning: judgment.finalActionReasoning,
            });
            return;
          }
          if (judgment.finalAction === 'not_applicable') {
            actionNotApplicable++;
            await this.logProcessed(runId, params.regionId, c.sourceId, {
              action: 'not_applicable',
              businessId: null,
              resolvedPlaceId: resolved.placeId,
              reasoning: judgment.finalActionReasoning,
            });
            return;
          }

          const needsReview = judgment.finalAction === 'review';
          const businessId = await insertBusinessOn(
            stagingConn,
            { regionId: params.regionId, runId },
            {
              overture: c,
              resolved,
              judgment,
              needsReview,
            },
          );
          if (needsReview) actionReview++;
          else actionAccept++;
          await this.logProcessed(runId, params.regionId, c.sourceId, {
            action: needsReview ? 'review' : 'accept',
            businessId,
            resolvedPlaceId: resolved.placeId,
            reasoning: judgment.finalActionReasoning,
          });

          // Auto-provision enrichment for the accept path. Discovery
          // inserts only carry name/address/coord/category — the
          // production gate (c2 real_cover, c3 real_hours) needs hours
          // + cover before the record is migration-eligible.
          //
          // Two steps, both best-effort (never fail the insert):
          //   1. Create the Drive + Gallery folder skeleton so the
          //      cover_sync webhook doesn't abort with "No drive
          //      found" — reuses DriveActivationService, same helper
          //      PostPublishService uses for the seeding-pipeline path.
          //   2. Queue resolve_business (hours) + cover_sync (cover)
          //      bot jobs against the placeId already resolved during
          //      discovery.
          if (!needsReview) {
            await this.provisionBusinessDrive(runId, businessId, stagingConn);
            await this.enqueueEnrichmentJobs(runId, businessId, resolved);
          }
        } catch (err) {
          errorCount++;
          this.logger.warn(
            `[${runId}] candidate ${c.sourceId} failed: ${(err as Error).message ?? err}`,
          );
          try {
            await this.logProcessed(runId, params.regionId, c.sourceId, {
              action: 'skip',
              businessId: null,
              resolvedPlaceId: null,
              reasoning: `error: ${(err as Error).message ?? err}`,
            });
          } catch {
            // Duplicate-key just means resume-skip already covers it.
          }
        } finally {
          processed++;
        }
      };

      const flushStats = async (): Promise<void> => {
        const u = this.claude.getUsage();
        await this.runModel
          .updateOne(
            { runId },
            {
              $set: {
                'stats.processed': processed,
                'stats.placesCallsTotal': placesCallsTotal,
                'stats.placesZeroResult': placesZeroResult,
                'stats.claudeCalls': u.calls - startingUsage.calls,
                'stats.claudeInputTokens':
                  u.inputTokens - startingUsage.inputTokens,
                'stats.claudeOutputTokens':
                  u.outputTokens - startingUsage.outputTokens,
                'stats.actionAccept': actionAccept,
                'stats.actionReview': actionReview,
                'stats.actionSkip': actionSkip,
                'stats.actionNotApplicable': actionNotApplicable,
                'stats.actionZeroResultNoInsert': actionZeroResult,
                'stats.errorCount': errorCount,
              },
            },
          )
          .catch(() => undefined);
      };
      const statsInterval = setInterval(() => {
        void flushStats();
      }, 5000);

      try {
        // Bounded-concurrency worker pool over toProcess. Each worker
        // pulls the next candidate index and runs the full pipeline
        // (resolve → dedup2 → judge → insert) end-to-end.
        const parallelism = Math.max(1, Math.min(params.parallelism, 20));
        let cursor = 0;
        const workers = Array.from({ length: parallelism }, async () => {
          while (true) {
            const i = cursor++;
            if (i >= toProcess.length) return;
            await processOne(toProcess[i]);
          }
        });
        await Promise.all(workers);
      } finally {
        clearInterval(statsInterval);
      }

      // Final stats write.
      const u = this.claude.getUsage();
      const totalWallSeconds = (Date.now() - t0) / 1000;
      await this.runModel.updateOne(
        { runId },
        {
          $set: {
            status: DiscoveryRunStatus.COMPLETED,
            completedAt: new Date(),
            'stats.processed': processed,
            'stats.placesCallsTotal': placesCallsTotal,
            'stats.placesZeroResult': placesZeroResult,
            'stats.claudeCalls': u.calls - startingUsage.calls,
            'stats.claudeInputTokens': u.inputTokens - startingUsage.inputTokens,
            'stats.claudeOutputTokens':
              u.outputTokens - startingUsage.outputTokens,
            'stats.actionAccept': actionAccept,
            'stats.actionReview': actionReview,
            'stats.actionSkip': actionSkip,
            'stats.actionNotApplicable': actionNotApplicable,
            'stats.actionZeroResultNoInsert': actionZeroResult,
            'stats.errorCount': errorCount,
          },
        },
      );
      this.logger.log(
        `[${runId}] DONE in ${totalWallSeconds.toFixed(1)}s: ` +
          `processed=${processed} placesCalls=${placesCallsTotal} ` +
          `zero_result=${actionZeroResult} accept=${actionAccept} ` +
          `review=${actionReview} skip=${actionSkip} ` +
          `not_applicable=${actionNotApplicable} errors=${errorCount}`,
      );
    } finally {
      await stagingConn.close();
    }
  }

  async getRun(runId: string): Promise<DiscoveryRunDocument | null> {
    return this.runModel.findOne({ runId }).lean() as any;
  }

  // Creates the Drive + Gallery folder skeleton for a discovery-inserted
  // business so downstream media handlers (cover_sync, gallery_menu,
  // image_sync) don't abort with "No drive found for business …".
  // Same helper the seeding-pipeline path uses via PostPublishService;
  // both methods are idempotent (safe on re-run). Best-effort — a
  // provisioning failure is logged but does not fail the insert.
  private async provisionBusinessDrive(
    runId: string,
    businessId: string,
    conn: mongoose.Connection,
  ): Promise<void> {
    try {
      const svc = new DriveActivationService();
      const drive = await svc.createDriveForBusiness({
        businessId,
        targetConnection: conn,
      });
      if (!drive.success) {
        this.logger.warn(
          `[${runId}] drive create failed for business ${businessId}: ${drive.message}`,
        );
        return;
      }
      const folder = await svc.createGalleryFolder({
        businessId,
        driveId: drive.driveId,
        targetConnection: conn,
      });
      if (!folder.success) {
        this.logger.warn(
          `[${runId}] gallery folder create failed for business ${businessId}: ${folder.message}`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `[${runId}] drive provisioning failed for business ${businessId}: ${(err as Error).message ?? err}`,
      );
    }
  }

  // Queues the two enrichment jobs that a fresh discovery-accept doc
  // needs before it can clear the production gate. Non-fatal on failure —
  // the enqueue is best-effort and cover-backfill / a re-triggered
  // resolve can pick up stragglers later.
  private async enqueueEnrichmentJobs(
    runId: string,
    businessId: string,
    resolved: {
      placeId: string;
      name: string;
      formattedAddress: string;
      lat: number;
      lng: number;
    },
  ): Promise<void> {
    const record = {
      placeId: resolved.placeId,
      businessId,
      businessName: resolved.name,
      environment: 'staging',
      addressLine1: resolved.formattedAddress,
      address1: resolved.formattedAddress,
      latitude: resolved.lat,
      longitude: resolved.lng,
    };
    try {
      await this.botJobService.createJobs({
        records: [record],
        type: BotJobType.RESOLVE_BUSINESS,
      });
      await this.botJobService.createJobs({
        records: [record],
        type: BotJobType.COVER_SYNC,
      });
    } catch (err) {
      this.logger.warn(
        `[${runId}] enrichment enqueue failed for business ${businessId}: ${(err as Error).message ?? err}`,
      );
    }
  }

  // One-off re-judgment for a specific run's needsReview cohort. Rebuilds
  // each record's JudgeInput from stored doc fields plus a re-pulled
  // Overture-by-sourceId map (overture name/address/coord aren't kept on
  // the Business doc after insert, so we reconstruct them from the same
  // parquet the original run used). Dedup is passed as null — recomputing
  // it against staging would trivially match the doc against itself and
  // wrongly flag every record as exact_duplicate.
  //
  // Used to recover the atlanta-ga run that ran while Ollama was down and
  // dumped 1449 records into review as fail-honestly placeholders. Same
  // pattern is fine for any future "GPU was down mid-run" recovery.
  async reJudgeRun(opts: {
    runId: string;
    dryRun: boolean;
    limit?: number;
    parallelism?: number;
    // 'review' (default): only touch docs currently needsReview:true.
    // 'all': also re-judge docs that were previously accepted, so a
    //         stricter gate change can correct wrong-accepts too.
    scope?: 'review' | 'all';
    // Optional narrowing filter: restrict re-judgment to docs whose
    // seedProvenance.overtureCategory matches one of these values. Used
    // to run a targeted sweep after adding rule-tier entries for a
    // specific set of overtureCategory values, so the before/after
    // comparison isn't muddied by LLM noise on unrelated docs.
    overtureCategories?: string[];
    // Resumable pass marker. Every successful re-judge write stamps
    // reJudgeRunId onto the business doc. Passing the same passId on a
    // later invocation skips docs already stamped with it, so a
    // mid-flight restart (pm2 restart, deploy, crash) resumes instead
    // of redoing the whole sweep. Omit to auto-generate a fresh passId
    // for a from-scratch sweep. Ignored when dryRun=true (no writes,
    // nothing to resume).
    passId?: string;
  }): Promise<{
    runId: string;
    regionId: string;
    dryRun: boolean;
    scope: 'review' | 'all';
    passId: string;
    // Docs in cohort that already matched this passId — skipped up front
    // (resume-from-restart case). Zero on a fresh pass.
    alreadyFreshCount: number;
    examined: number;
    missingOverture: number;
    fromReview: {
      toAccept: number;
      toSkip: number;
      toNotApplicable: number;
      stayReview: number;
    };
    fromAccept: {
      toReview: number;
      toSkip: number;
      toNotApplicable: number;
      stayAccept: number;
    };
    updates?: number;
  }> {
    const run = await this.runModel.findOne({ runId: opts.runId }).lean();
    if (!run) throw new Error(`No run: ${opts.runId}`);
    const region = await this.regionModel.findOne({ regionId: run.regionId }).lean();
    if (!region) throw new Error(`No region: ${run.regionId}`);

    const bbox = {
      west: region.bbox.west,
      south: region.bbox.south,
      east: region.bbox.east,
      north: region.bbox.north,
    };

    this.logger.log(`[reJudgeRun ${opts.runId}] pulling Overture for bbox…`);
    const candidates = await fetchOverturePlacesInBbox(bbox);
    const bySourceId = new Map<string, OvertureCandidate>();
    for (const c of candidates) bySourceId.set(c.sourceId, c);
    this.logger.log(
      `[reJudgeRun ${opts.runId}] overture rows=${candidates.length}, indexed=${bySourceId.size}`,
    );

    const stagingUri = this.configService.get<string>('database.pinntagStaging');
    if (!stagingUri) throw new Error('No URI for pinntagStaging');
    const conn = await openStagingConnection(stagingUri);
    try {
      const BusinessModel =
        conn.models['Business'] ||
        conn.model(
          'Business',
          new mongoose.Schema({}, { strict: false }),
          'businesses',
        );

      const scope: 'review' | 'all' = opts.scope ?? 'review';
      const passId =
        opts.passId ??
        `rejudge_${Date.now()}_${randomUUID().slice(0, 8)}`;
      // Base cohort selector — same as before.
      const cohortQuery: Record<string, any> = {
        'seedProvenance.runId': opts.runId,
        isDeleted: { $ne: true },
      };
      if (scope === 'review') cohortQuery.needsReview = true;
      const ovCats = (opts.overtureCategories ?? []).filter(
        (s) => typeof s === 'string' && s.length > 0,
      );
      if (ovCats.length > 0) {
        cohortQuery['seedProvenance.overtureCategory'] = { $in: ovCats };
      }

      // For resumability, exclude docs already stamped with this
      // passId (stamped by a prior invocation that got interrupted).
      // Dry-run mode intentionally does not stamp, so nothing is ever
      // "already fresh" under dryRun — and we don't filter here either
      // (running two dry-runs shouldn't silently drop coverage).
      const workQuery: Record<string, any> = { ...cohortQuery };
      if (!opts.dryRun) {
        workQuery.$or = [
          { reJudgeRunId: { $exists: false } },
          { reJudgeRunId: { $ne: passId } },
        ];
      }

      const alreadyFreshCount = opts.dryRun
        ? 0
        : await BusinessModel.countDocuments({
            ...cohortQuery,
            reJudgeRunId: passId,
          });

      const findOpts = opts.limit && opts.limit > 0 ? { limit: opts.limit } : {};
      const docs = (await BusinessModel.find(workQuery, {
        _id: 1,
        placeId: 1,
        name: 1,
        addressLine1: 1,
        latitude: 1,
        longitude: 1,
        needsReview: 1,
        seedProvenance: 1,
      }, findOpts).lean()) as any[];

      this.logger.log(
        `[reJudgeRun ${opts.runId}] passId=${passId} scope=${scope} ` +
          `alreadyFresh=${alreadyFreshCount} docsToProcess=${docs.length}`,
      );

      let missingOverture = 0;
      let updates = 0;
      // From-review flips.
      let reviewToAccept = 0;
      let reviewToSkip = 0;
      let reviewToNotApplicable = 0;
      let stayReview = 0;
      // From-accept flips (only populated when scope='all').
      let acceptToReview = 0;
      let acceptToSkip = 0;
      let acceptToNotApplicable = 0;
      let stayAccept = 0;

      const parallelism = Math.max(1, Math.min(opts.parallelism ?? 5, 15));
      let cursor = 0;

      const processOne = async (doc: any): Promise<void> => {
        const sourceId = doc?.seedProvenance?.overtureSourceId as string | undefined;
        const overture = sourceId ? bySourceId.get(sourceId) : undefined;
        if (!overture) {
          missingOverture++;
          return;
        }
        const resolved = {
          placeId: String(doc.placeId),
          name: String(doc.name),
          formattedAddress: String(doc.addressLine1 ?? ''),
          lat: Number(doc.latitude),
          lng: Number(doc.longitude),
        };
        const dist = haversineMeters(
          overture.lat,
          overture.lng,
          resolved.lat,
          resolved.lng,
        );
        const sim = nameSimilarity(
          normalizeName(overture.name),
          normalizeName(resolved.name),
        );
        const matchConfirmed =
          dist <= MATCH_CONFIRM_MAX_DIST_M && sim >= MATCH_CONFIRM_MIN_NAME_SIM;
        const matchReason = `name_sim=${sim.toFixed(2)} dist=${dist.toFixed(0)}m`;

        const judgment = await this.judgment.judgeRecord({
          overture: {
            name: overture.name,
            address: overture.address,
            lat: overture.lat,
            lng: overture.lng,
            category: overture.overtureCategory,
            sourceId: overture.sourceId,
          },
          resolved: { ...resolved, matchConfirmed, matchReason },
          dedup: null,
        });

        const wasReview = !!doc.needsReview;
        if (wasReview) {
          if (judgment.finalAction === 'accept') reviewToAccept++;
          else if (judgment.finalAction === 'skip') reviewToSkip++;
          else if (judgment.finalAction === 'not_applicable') reviewToNotApplicable++;
          else stayReview++;
        } else {
          if (judgment.finalAction === 'accept') stayAccept++;
          else if (judgment.finalAction === 'skip') acceptToSkip++;
          else if (judgment.finalAction === 'not_applicable') acceptToNotApplicable++;
          else acceptToReview++;
        }

        if (!opts.dryRun) {
          await BusinessModel.updateOne(
            { _id: doc._id },
            {
              $set: {
                llmJudgment: judgment,
                needsReview: judgment.needsReview,
                needsReviewByJudge: judgment.needsReviewByJudge,
                // Freshness marker for resumable re-judge sweeps. Set
                // atomically with the judgment fields so a mid-write
                // crash never leaves a doc "stamped fresh but stale".
                reJudgeRunId: passId,
                lastReJudgedAt: new Date(),
              },
            },
          );
          updates++;
        }
      };

      const workers = Array.from({ length: parallelism }, async () => {
        while (true) {
          const i = cursor++;
          if (i >= docs.length) return;
          try {
            await processOne(docs[i]);
          } catch (err) {
            this.logger.warn(
              `[reJudgeRun ${opts.runId}] doc ${docs[i]?._id} failed: ${(err as Error).message ?? err}`,
            );
            if (docs[i]?.needsReview) stayReview++;
            else stayAccept++;
          }
        }
      });
      await Promise.all(workers);

      this.logger.log(
        `[reJudgeRun ${opts.runId}] ${opts.dryRun ? 'DRY-RUN' : 'APPLIED'} scope=${scope} ` +
          `passId=${passId} alreadyFresh=${alreadyFreshCount} examined=${docs.length} ` +
          `missingOverture=${missingOverture} | ` +
          `fromReview→ accept=${reviewToAccept} skip=${reviewToSkip} na=${reviewToNotApplicable} stay=${stayReview} | ` +
          `fromAccept→ review=${acceptToReview} skip=${acceptToSkip} na=${acceptToNotApplicable} stay=${stayAccept} | ` +
          `updates=${updates}`,
      );

      return {
        runId: opts.runId,
        regionId: String(run.regionId),
        dryRun: opts.dryRun,
        scope,
        passId,
        alreadyFreshCount,
        examined: docs.length,
        missingOverture,
        fromReview: {
          toAccept: reviewToAccept,
          toSkip: reviewToSkip,
          toNotApplicable: reviewToNotApplicable,
          stayReview,
        },
        fromAccept: {
          toReview: acceptToReview,
          toSkip: acceptToSkip,
          toNotApplicable: acceptToNotApplicable,
          stayAccept,
        },
        updates: opts.dryRun ? undefined : updates,
      };
    } finally {
      await conn.close();
    }
  }

  private async markFailed(runId: string, error: string): Promise<void> {
    await this.runModel.updateOne(
      { runId },
      {
        $set: {
          status: DiscoveryRunStatus.FAILED,
          completedAt: new Date(),
          error,
        },
      },
    );
  }

  private async logProcessed(
    runId: string,
    regionId: string,
    overtureSourceId: string,
    payload: {
      action: DiscoveryFinalAction;
      businessId: string | null;
      resolvedPlaceId: string | null;
      reasoning: string;
    },
  ): Promise<void> {
    try {
      await this.processedModel.create({
        runId,
        regionId,
        overtureSourceId,
        action: payload.action,
        businessId: payload.businessId,
        resolvedPlaceId: payload.resolvedPlaceId,
        reasoning: payload.reasoning,
      });
    } catch (e) {
      // Unique-index violation just means another worker (or a
      // prior run) already logged this sourceId. Not fatal —
      // resume-skip already prevented double-processing; the log
      // insert is best-effort audit.
      const msg = (e as any)?.code === 11000 ? 'dup_key (ok)' : (e as Error).message;
      this.logger.debug(
        `logProcessed ${regionId}/${overtureSourceId}: ${msg}`,
      );
    }
  }

  private async loadProcessedSourceIds(regionId: string): Promise<Set<string>> {
    const docs = (await this.processedModel
      .find({ regionId }, { overtureSourceId: 1 })
      .lean()) as any[];
    return new Set(docs.map((d) => String(d.overtureSourceId)));
  }

  private async placeIdExistsInStaging(
    conn: mongoose.Connection,
    placeId: string,
  ): Promise<{ isSeeded: boolean } | null> {
    const BusinessModel =
      conn.models['Business'] ||
      conn.model(
        'Business',
        new mongoose.Schema({}, { strict: false }),
        'businesses',
      );
    const doc = (await BusinessModel.findOne(
      { placeId, isDeleted: { $ne: true } },
      {
        placeId: 1,
        isCvb: 1,
        isFromCrawler: 1,
        'seedProvenance.isSeeded': 1,
      },
    ).lean()) as any;
    if (!doc) return null;
    return {
      isSeeded: !!(doc.isCvb || doc.isFromCrawler || doc.seedProvenance?.isSeeded),
    };
  }

  private async loadSeededInBbox(bbox: {
    west: number;
    south: number;
    east: number;
    north: number;
  }): Promise<Array<{ name: string; normalized: string; lat: number; lng: number }>> {
    const uri = this.configService.get<string>('database.pinntagStaging');
    if (!uri) throw new Error('No URI for pinntagStaging');
    const conn = await mongoose.createConnection(uri).asPromise();
    try {
      const BusinessModel = conn.model(
        'DiscBiz',
        new mongoose.Schema({}, { strict: false }),
        'businesses',
      );
      const docs = (await BusinessModel.find(
        {
          $and: [
            buildSeededFilter(),
            { latitude: { $gte: bbox.south, $lte: bbox.north } },
            { longitude: { $gte: bbox.west, $lte: bbox.east } },
            { isDeleted: { $ne: true } },
          ],
        },
        { name: 1, latitude: 1, longitude: 1 },
      ).lean()) as any[];
      return docs
        .filter(
          (d) =>
            typeof d.latitude === 'number' &&
            typeof d.longitude === 'number' &&
            d.name,
        )
        .map((d) => ({
          name: String(d.name),
          normalized: normalizeName(String(d.name)),
          lat: d.latitude,
          lng: d.longitude,
        }));
    } finally {
      await conn.close();
    }
  }

  private dedupPass1(
    candidates: OvertureCandidate[],
    seeded: Array<{ name: string; normalized: string; lat: number; lng: number }>,
    centerLat: number,
  ): { alreadyInCorpus: number; newCandidates: OvertureCandidate[] } {
    const latStep = metersToLatDeg(DEDUP_RADIUS_M);
    const lngStep = metersToLngDeg(DEDUP_RADIUS_M, centerLat);
    const grid = new Map<string, typeof seeded>();
    const keyOf = (lat: number, lng: number): string => {
      const li = Math.floor(lat / latStep);
      const lj = Math.floor(lng / lngStep);
      return `${li}:${lj}`;
    };
    for (const s of seeded) {
      const k = keyOf(s.lat, s.lng);
      const arr = grid.get(k);
      if (arr) arr.push(s);
      else grid.set(k, [s]);
    }
    let alreadyInCorpus = 0;
    const newCandidates: OvertureCandidate[] = [];
    for (const c of candidates) {
      const li = Math.floor(c.lat / latStep);
      const lj = Math.floor(c.lng / lngStep);
      const cNorm = normalizeName(c.name);
      let matched = false;
      outer: for (let di = -1; di <= 1 && !matched; di++) {
        for (let dj = -1; dj <= 1; dj++) {
          const bucket = grid.get(`${li + di}:${lj + dj}`);
          if (!bucket) continue;
          for (const s of bucket) {
            const dist = haversineMeters(c.lat, c.lng, s.lat, s.lng);
            if (dist > DEDUP_RADIUS_M) continue;
            const sim = nameSimilarity(cNorm, s.normalized);
            if (sim >= NAME_SIM_THRESHOLD) {
              matched = true;
              break outer;
            }
          }
        }
      }
      if (matched) alreadyInCorpus++;
      else newCandidates.push(c);
    }
    return { alreadyInCorpus, newCandidates };
  }
}
