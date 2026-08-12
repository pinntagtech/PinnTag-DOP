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
import {
  resolvePlaceIdBySearchText,
} from './places-client';
import { JudgmentService } from '../judgment/judgment.service';
import { ClaudeClient } from '../judgment/claude-client';
import {
  insertBusinessOn,
  openStagingConnection,
} from './business-insert';

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

    // 7. Process with concurrency cap.
    const stagingUri = this.configService.get<string>('database.pinntagStaging');
    if (!stagingUri) throw new Error('No URI for pinntagStaging');
    const apiKey = this.configService.get<string>('app.googleApiKey');
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

      const inFlight = new Set<Promise<void>>();
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
              reasoning: 'places searchText returned no result inside rectangle',
            });
            return;
          }

          // Compute matchConfirmed BEFORE judgment (judge needs it in input).
          const dist = haversineMeters(c.lat, c.lng, resolved.lat, resolved.lng);
          const sim = nameSimilarity(normalizeName(c.name), normalizeName(resolved.name));
          const matchConfirmed =
            dist <= MATCH_CONFIRM_MAX_DIST_M && sim >= MATCH_CONFIRM_MIN_NAME_SIM;
          const matchReason = `name_sim=${sim.toFixed(2)} dist=${dist.toFixed(0)}m`;

          // Dedup pass 2 — check the resolved placeId against staging
          // ONLY for this run. Prod check adds latency at scale; we
          // cover it via post-run reconciliation. NB: reads only, not
          // a mutation.
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

          // Route by finalAction.
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

          // accept or review → insert.
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
        } catch (err) {
          errorCount++;
          this.logger.warn(
            `[${runId}] candidate ${c.sourceId} failed: ${(err as Error).message ?? err}`,
          );
          // Log the processed row so a retry won't re-attempt a
          // permanently-broken candidate. Use a dedicated action so
          // reporting can distinguish these from real skips.
          try {
            await this.logProcessed(runId, params.regionId, c.sourceId, {
              action: 'skip',
              businessId: null,
              resolvedPlaceId: null,
              reasoning: `error: ${(err as Error).message ?? err}`,
            });
          } catch {
            // If even the log write fails (e.g. duplicate key), swallow —
            // resume-skip will handle it via the unique index.
          }
        }
      };

      // Simple concurrency pool without a dep.
      const iter = toProcess[Symbol.iterator]();
      const workers: Promise<void>[] = [];
      const spawn = async (): Promise<void> => {
        while (true) {
          const next = iter.next();
          if (next.done) return;
          await processOne(next.value);
          // Periodic stats flush so a poller sees progress.
          if ((placesCallsTotal & 15) === 0) {
            const u = this.claude.getUsage();
            await this.runModel
              .updateOne(
                { runId },
                {
                  $set: {
                    'stats.processed':
                      actionAccept + actionReview + actionSkip + actionNotApplicable + actionZeroResult,
                    'stats.placesCallsTotal': placesCallsTotal,
                    'stats.placesZeroResult': placesZeroResult,
                    'stats.claudeCalls': u.calls - startingUsage.calls,
                    'stats.claudeInputTokens': u.inputTokens - startingUsage.inputTokens,
                    'stats.claudeOutputTokens': u.outputTokens - startingUsage.outputTokens,
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
          }
        }
      };
      for (let i = 0; i < params.parallelism; i++) {
        workers.push(spawn());
      }
      await Promise.all(workers);

      // Final stats write.
      const u = this.claude.getUsage();
      const totalWallSeconds = (Date.now() - t0) / 1000;
      await this.runModel.updateOne(
        { runId },
        {
          $set: {
            status: DiscoveryRunStatus.COMPLETED,
            completedAt: new Date(),
            'stats.processed':
              actionAccept + actionReview + actionSkip + actionNotApplicable + actionZeroResult,
            'stats.placesCallsTotal': placesCallsTotal,
            'stats.placesZeroResult': placesZeroResult,
            'stats.claudeCalls': u.calls - startingUsage.calls,
            'stats.claudeInputTokens': u.inputTokens - startingUsage.inputTokens,
            'stats.claudeOutputTokens': u.outputTokens - startingUsage.outputTokens,
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
          `accept=${actionAccept} review=${actionReview} skip=${actionSkip} ` +
          `not_applicable=${actionNotApplicable} zero_result=${actionZeroResult} ` +
          `errors=${errorCount}`,
      );
    } finally {
      await stagingConn.close();
    }
  }

  async getRun(runId: string): Promise<DiscoveryRunDocument | null> {
    return this.runModel.findOne({ runId }).lean() as any;
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
