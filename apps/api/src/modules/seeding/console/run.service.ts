import { HttpException, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import mongoose, { Model } from 'mongoose';
import { ConsoleService } from './console.service';
import { GateService } from './gate.service';
import { ProvenanceService } from './provenance.service';
import { SeedingPipelineService } from '../seeding-pipeline.service';
import { BotJobService } from '../bot/bot-job.service';
import { BotJobType } from '../schemas/bot-job.schema';
import {
  ConsoleRun,
  ConsoleRunDocument,
  ConsoleRunStatus,
} from './console-run.schema';
import type { ConsoleActionType, ConsoleSelection } from './console.types';

const LOG_TAIL_LIMIT = 200;
const PROGRESS_UPDATE_EVERY = 50;
const BOT_TRIGGER_BATCH = 100;

// Every action that requires the admin password on the LIVE path. Dry
// runs skip this gate. The set matches the rule the operator asked for:
// anything that could hide the whole corpus (deactivate), push ungated
// data live (activate), delete losers (dedup_place_id), or mutate every
// row's city (resync_city).
const ADMIN_PASSWORD_ACTIONS = new Set<ConsoleActionType>([
  'resync_city',
  'dedup_place_id',
  'strip_placeholder_covers',
  'activate',
  'deactivate',
]);

// Actions with no backing implementation yet. The dispatcher accepts
// them, logs "stage not yet available", and returns success — never
// touches a write. Kept minimal on purpose so an operator sees the
// action in the menu and knows it's known-but-pending.
//
// (email_scrape now HAS an implementation via the email_scraper.py bot
// stage — it goes through runTriggerBot with BotJobType.EMAIL_SCRAPE.)
const NOT_YET_AVAILABLE_ACTIONS: ConsoleActionType[] = [];

@Injectable()
export class RunService {
  private readonly logger = new Logger(RunService.name);

  constructor(
    @InjectModel(ConsoleRun.name)
    private readonly runModel: Model<ConsoleRunDocument>,
    private readonly consoleService: ConsoleService,
    private readonly gateService: GateService,
    private readonly provenanceService: ProvenanceService,
    private readonly pipelineService: SeedingPipelineService,
    private readonly botJobService: BotJobService,
  ) {}

  // ── Public API ────────────────────────────────────────────────────────

  async list(opts: { page?: number; pageSize?: number } = {}) {
    const page = Math.max(1, opts.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, opts.pageSize ?? 25));
    const [items, total] = await Promise.all([
      this.runModel
        .find(
          {},
          {
            action: 1,
            environment: 1,
            selectionSummary: 1,
            dryRun: 1,
            total: 1,
            processed: 1,
            succeeded: 1,
            failed: 1,
            skipped: 1,
            status: 1,
            startedBy: 1,
            startedAt: 1,
            finishedAt: 1,
            error: 1,
            createdAt: 1,
          },
        )
        .sort({ createdAt: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .lean(),
      this.runModel.countDocuments({}),
    ]);
    return { items, total, page, pageSize };
  }

  async get(runId: string) {
    if (!mongoose.isValidObjectId(runId)) {
      throw new HttpException('Invalid runId', 400);
    }
    const doc = await this.runModel.findById(runId).lean();
    if (!doc) throw new HttpException('Run not found', 404);
    return doc;
  }

  // Launch an action. Creates the run doc, returns { runId } in the
  // same tick, and processes the selection in the background. The HTTP
  // client can disconnect (or its JWT can expire) without stopping the
  // run — that's the whole point of moving off the synchronous curl
  // loops that used to fail every 15 minutes.
  async launch(input: {
    action: ConsoleActionType;
    environment: string;
    selection: ConsoleSelection;
    dryRun: boolean;
    adminPassword?: string;
    options?: Record<string, any>;
    actor: string;
  }): Promise<{ runId: string }> {
    // Read-only "actions" (recomputes) don't need a staging lock — they
    // touch only their own bookkeeping subdocs. Every write action does.
    // See launchGateRecompute / launchProvenanceRecompute for their own
    // (thin) launch paths.
    if (input.action === 'gate_recompute') {
      return this.launchGateRecompute(input);
    }
    if (input.action === 'provenance_recompute') {
      return this.launchProvenanceRecompute(input);
    }

    assertStagingWrite(input.environment);

    // Admin-password gate for the destructive-adjacent actions. LIVE
    // runs only — dry-run is free-to-run because it writes nothing.
    if (
      !input.dryRun &&
      ADMIN_PASSWORD_ACTIONS.has(input.action) &&
      !input.adminPassword
    ) {
      throw new HttpException(
        `${input.action} requires adminPassword on a live run`,
        400,
      );
    }

    const selectionSummary = this.selectionSummary(input.selection);

    const run = await this.runModel.create({
      action: input.action,
      environment: input.environment,
      selectionSummary,
      dryRun: input.dryRun,
      startedBy: input.actor,
      status: ConsoleRunStatus.QUEUED,
    });

    // Fire-and-forget. Any errors captured onto the run doc by execute().
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    this.execute(String(run._id), input).catch((err) => {
      this.logger.error(
        `[RUN ${String(run._id)}] unexpected top-level failure: ${err?.message}`,
      );
    });

    return { runId: String(run._id) };
  }

  // Convenience wrapper used by the /selection/preview endpoint.
  async previewSelectionCount(
    environment: string,
    selection: ConsoleSelection,
  ): Promise<number> {
    return this.consoleService.countSelection(environment, selection);
  }

  // ── Selection helpers ─────────────────────────────────────────────────

  private selectionSummary(sel: ConsoleSelection): Record<string, any> {
    if (sel.mode === 'ids') {
      return { mode: 'ids', idCount: sel.ids?.length ?? 0 };
    }
    return {
      mode: 'filter',
      filter: sel.filter ?? {},
      excludeIdCount: sel.excludeIds?.length ?? 0,
    };
  }

  // ── Progress persistence ──────────────────────────────────────────────

  private async appendLog(
    runId: string,
    level: 'info' | 'warn' | 'error',
    message: string,
  ): Promise<void> {
    await this.runModel.updateOne(
      { _id: runId },
      {
        $push: {
          log: {
            $each: [{ ts: new Date(), level, message }],
            $slice: -LOG_TAIL_LIMIT,
          },
        },
      },
    );
  }

  private async patch(
    runId: string,
    fields: Record<string, any>,
  ): Promise<void> {
    await this.runModel.updateOne({ _id: runId }, { $set: fields });
  }

  private async incrementCounters(
    runId: string,
    delta: Partial<
      Pick<ConsoleRun, 'processed' | 'succeeded' | 'failed' | 'skipped'>
    >,
  ): Promise<void> {
    const inc: Record<string, number> = {};
    for (const k of ['processed', 'succeeded', 'failed', 'skipped'] as const) {
      if (delta[k]) inc[k] = delta[k]!;
    }
    if (Object.keys(inc).length === 0) return;
    await this.runModel.updateOne({ _id: runId }, { $inc: inc });
  }

  // ── Dispatch ──────────────────────────────────────────────────────────

  private async execute(
    runId: string,
    input: Parameters<RunService['launch']>[0],
  ): Promise<void> {
    const started = Date.now();
    try {
      await this.patch(runId, {
        status: ConsoleRunStatus.RUNNING,
        startedAt: new Date(),
      });

      if (NOT_YET_AVAILABLE_ACTIONS.includes(input.action)) {
        await this.appendLog(
          runId,
          'warn',
          `Action ${input.action}: stage not yet available. No writes performed.`,
        );
        await this.patch(runId, {
          status: ConsoleRunStatus.DONE,
          finishedAt: new Date(),
        });
        return;
      }

      const total = await this.consoleService.countSelection(
        input.environment,
        input.selection,
      );
      await this.patch(runId, { total });
      await this.appendLog(
        runId,
        'info',
        `Selection resolved: ${total} record(s). dryRun=${input.dryRun}.`,
      );

      switch (input.action) {
        case 'resync_city':
          await this.runResyncCity(runId, input, total);
          break;
        case 'dedup_place_id':
          await this.runDedup(runId, input);
          break;
        case 'strip_placeholder_covers':
          await this.runStripPlaceholderCovers(runId, input);
          break;
        case 'trigger_cover_sync':
          await this.runTriggerBot(runId, input, BotJobType.COVER_SYNC);
          break;
        case 'trigger_image_sync':
          await this.runTriggerBot(runId, input, BotJobType.IMAGE_SYNC);
          break;
        case 'trigger_gallery_menu':
          await this.runTriggerBot(runId, input, BotJobType.GALLERY_MENU);
          break;
        case 'trigger_reviews':
          await this.runTriggerBot(runId, input, BotJobType.REVIEWS);
          break;
        case 'trigger_email_scrape':
          await this.runTriggerBot(runId, input, BotJobType.EMAIL_SCRAPE);
          break;
        case 're_resolve':
          // Re-resolve uses the RESOLVE_BUSINESS bot job type. The
          // resolve-retry strategy improvement itself is separate work.
          await this.runTriggerBot(runId, input, BotJobType.RESOLVE_BUSINESS);
          break;
        case 'activate':
          await this.runFlipActive(runId, input, true);
          break;
        case 'deactivate':
          await this.runFlipActive(runId, input, false);
          break;
        default:
          throw new HttpException(`Unknown action: ${input.action}`, 400);
      }

      const durationMs = Date.now() - started;
      await this.appendLog(
        runId,
        'info',
        `Complete in ${(durationMs / 1000).toFixed(1)}s.`,
      );
      await this.patch(runId, {
        status: ConsoleRunStatus.DONE,
        finishedAt: new Date(),
      });
    } catch (err: any) {
      this.logger.error(
        `[RUN ${runId}] ${input.action} failed: ${err?.message}`,
      );
      await this.appendLog(runId, 'error', err?.message ?? String(err));
      await this.patch(runId, {
        status: ConsoleRunStatus.FAILED,
        finishedAt: new Date(),
        error: err?.message ?? String(err),
      });
    }
  }

  // ── Action: gate_recompute ────────────────────────────────────────────

  private async launchGateRecompute(
    input: Parameters<RunService['launch']>[0],
  ): Promise<{ runId: string }> {
    const run = await this.runModel.create({
      action: 'gate_recompute',
      environment: input.environment,
      selectionSummary: { mode: 'all-seeded' },
      dryRun: false,
      startedBy: input.actor,
      status: ConsoleRunStatus.QUEUED,
    });
    const runId = String(run._id);
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    (async () => {
      try {
        await this.patch(runId, {
          status: ConsoleRunStatus.RUNNING,
          startedAt: new Date(),
        });
        const r = await this.gateService.recompute(input.environment);
        await this.patch(runId, {
          status: ConsoleRunStatus.DONE,
          finishedAt: new Date(),
          total: r.scanned,
          processed: r.scanned,
          succeeded: r.updated,
          result: r,
        });
        await this.appendLog(
          runId,
          'info',
          `Recompute: scanned=${r.scanned} updated=${r.updated} ` +
            `passLegacy9=${r.totals.passLegacy9} ` +
            `passPerfect11=${r.totals.passPerfect11} ` +
            `dupPlaceIds=${r.duplicatePlaceIds} ` +
            `in ${(r.durationMs / 1000).toFixed(1)}s.`,
        );
      } catch (err: any) {
        await this.appendLog(runId, 'error', err?.message ?? String(err));
        await this.patch(runId, {
          status: ConsoleRunStatus.FAILED,
          finishedAt: new Date(),
          error: err?.message ?? String(err),
        });
      }
    })();
    return { runId };
  }

  // ── Action: provenance_recompute ──────────────────────────────────────

  private async launchProvenanceRecompute(
    input: Parameters<RunService['launch']>[0],
  ): Promise<{ runId: string }> {
    const run = await this.runModel.create({
      action: 'provenance_recompute',
      environment: input.environment,
      selectionSummary: { mode: 'all-seeded' },
      dryRun: input.dryRun,
      startedBy: input.actor,
      status: ConsoleRunStatus.QUEUED,
    });
    const runId = String(run._id);
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    (async () => {
      try {
        await this.patch(runId, {
          status: ConsoleRunStatus.RUNNING,
          startedAt: new Date(),
        });
        const r = await this.provenanceService.recompute({
          environment: input.environment,
          dryRun: input.dryRun,
        });
        await this.patch(runId, {
          status: ConsoleRunStatus.DONE,
          finishedAt: new Date(),
          total: r.scanned,
          processed: r.scanned,
          succeeded: r.updated,
          result: r,
        });
        await this.appendLog(
          runId,
          'info',
          `Provenance recompute dryRun=${r.dryRun}: scanned=${r.scanned} ` +
            `updated=${r.updated} isSeededAfter=${r.totals.isSeededAfter} ` +
            `netNew=${r.totals.netNewIsSeeded} ` +
            `in ${(r.durationMs / 1000).toFixed(1)}s.`,
        );
      } catch (err: any) {
        await this.appendLog(runId, 'error', err?.message ?? String(err));
        await this.patch(runId, {
          status: ConsoleRunStatus.FAILED,
          finishedAt: new Date(),
          error: err?.message ?? String(err),
        });
      }
    })();
    return { runId };
  }

  // ── Action: resync_city ───────────────────────────────────────────────

  private async runResyncCity(
    runId: string,
    input: Parameters<RunService['launch']>[0],
    total: number,
  ): Promise<void> {
    if (!input.dryRun && !input.adminPassword) {
      throw new HttpException(
        'resync_city requires adminPassword on a live run',
        400,
      );
    }
    // Collect IDs from the selection cursor. Even a 20k-record selection
    // is fine here (small ObjectIds, no doc payload). The pipeline method
    // ignores id caps, so we send them all at once.
    const ids: string[] = [];
    for await (const oid of this.consoleService.iterateSelectionIds(
      input.environment,
      input.selection,
    )) {
      ids.push(String(oid));
    }

    const result = await this.pipelineService.resyncCityFromAddressLine1({
      environment: input.environment,
      // Pipeline verifyAdminPassword rejects an empty string, so pass ''
      // on the dry-run path — service treats dryRun before it verifies.
      adminPassword: input.adminPassword ?? '',
      dryRun: input.dryRun,
      businessIds: ids,
    });

    await this.incrementCounters(runId, {
      processed: result.totals.scanned,
      succeeded: result.totals.corrected,
      skipped: result.totals.skippedAmbiguous,
    });
    await this.patch(runId, { result, total });
    await this.appendLog(
      runId,
      'info',
      `resync_city dryRun=${input.dryRun}: ` +
        `scanned=${result.totals.scanned} ` +
        `mismatches=${result.totals.mismatchCount} ` +
        `corrected=${result.totals.corrected} ` +
        `skippedAmbiguous=${result.totals.skippedAmbiguous}`,
    );
  }

  // ── Action: dedup_place_id ────────────────────────────────────────────

  private async runDedup(
    runId: string,
    input: Parameters<RunService['launch']>[0],
  ): Promise<void> {
    if (!input.dryRun && !input.adminPassword) {
      throw new HttpException(
        'dedup_place_id requires adminPassword on a live run',
        400,
      );
    }

    // The dedup service works per-placeId, not per-businessId. If the
    // selection is ids, we resolve those into the set of placeIds they
    // share and pass those in as a narrowing filter. If the selection is
    // filter mode, we let dedup scan everything it would normally scan;
    // it is already scoped to the seeded set (see the recovered
    // dedupBusinessesByPlaceId in seeding-pipeline.service.ts).
    let placeIds: string[] | undefined = undefined;
    if (input.selection.mode === 'ids') {
      const conn = await this.gateService.openConnection(input.environment);
      try {
        const businesses = conn.collection('businesses');
        const oids = (input.selection.ids ?? [])
          .filter((id) => mongoose.isValidObjectId(id))
          .map((id) => new mongoose.Types.ObjectId(id));
        const docs = (await businesses
          .find({ _id: { $in: oids } }, { projection: { placeId: 1 } })
          .toArray()) as any[];
        placeIds = Array.from(
          new Set(
            docs
              .map((d) => (typeof d.placeId === 'string' ? d.placeId : ''))
              .filter(Boolean),
          ),
        );
      } finally {
        await conn.close();
      }
    }

    const result = await this.pipelineService.dedupBusinessesByPlaceId({
      environment: input.environment,
      adminPassword: input.adminPassword ?? '',
      dryRun: input.dryRun,
      placeIds,
    });

    await this.incrementCounters(runId, {
      processed: result.totals.groupsProcessed,
      succeeded: result.totals.losersDeleted,
      skipped:
        result.totals.groupsFlaggedForReview +
        result.totals.groupsFlaggedManualReview,
    });
    await this.patch(runId, { result });
    await this.appendLog(
      runId,
      'info',
      `dedup_place_id dryRun=${input.dryRun}: ` +
        `groupsFound=${result.totals.duplicateGroupsFound} ` +
        `losersDeleted=${result.totals.losersDeleted} ` +
        `flagged=${result.totals.groupsFlaggedForReview} ` +
        `manualReview=${result.totals.groupsFlaggedManualReview}`,
    );
  }

  // ── Action: strip_placeholder_covers ──────────────────────────────────
  //
  // Removes the pinntag-assets Defaults/* placeholder from `cover`,
  // `coverThumbnail`, `coverUploaded`, and `logo` (only where the field
  // itself is a placeholder). Never touches a real B2 cover — the
  // pipeline guard checks isPlaceholderAsset() per field before every
  // $unset. Resolves the selection to ids so ids-mode and filter-mode
  // both narrow the pipeline's own scan.
  private async runStripPlaceholderCovers(
    runId: string,
    input: Parameters<RunService['launch']>[0],
  ): Promise<void> {
    if (!input.dryRun && !input.adminPassword) {
      throw new HttpException(
        'strip_placeholder_covers requires adminPassword on a live run',
        400,
      );
    }
    const ids: string[] = [];
    for await (const oid of this.consoleService.iterateSelectionIds(
      input.environment,
      input.selection,
    )) {
      ids.push(String(oid));
    }

    const result = await this.pipelineService.stripPlaceholderCovers({
      environment: input.environment,
      adminPassword: input.adminPassword ?? '',
      dryRun: input.dryRun,
      businessIds: ids,
    });

    // processed = scanned; succeeded = stripped; skipped = docs the
    // Mongo match returned but which no longer matched the per-field
    // guard (typically 0 — belt-and-braces).
    await this.incrementCounters(runId, {
      processed: result.totals.scanned,
      succeeded: result.totals.stripped,
      skipped: result.totals.scanned - result.totals.stripped,
    });
    await this.patch(runId, { result });
    await this.appendLog(
      runId,
      'info',
      `strip_placeholder_covers dryRun=${input.dryRun}: ` +
        `scanned=${result.totals.scanned} ` +
        `placeholderCovers=${result.totals.placeholderCovers} ` +
        `placeholderLogos=${result.totals.placeholderLogos} ` +
        `coverSyncEligible=${result.totals.coverSyncEligible} ` +
        `unrecoverable=${result.totals.unrecoverable} ` +
        `stripped=${result.totals.stripped}`,
    );
  }

  // ── Action: trigger_* bot job types ───────────────────────────────────
  //
  // Fetch just the fields the bot needs, batched, so a 5k-row selection
  // doesn't stream every business through the API process. createJobs
  // internally validates required fields and rejects bad records.
  private async runTriggerBot(
    runId: string,
    input: Parameters<RunService['launch']>[0],
    type: BotJobType,
  ): Promise<void> {
    const conn = await this.gateService.openConnection(input.environment);
    try {
      const businesses = conn.collection('businesses');
      let batch: Array<{
        placeId: string;
        businessId: string;
        businessName: string;
        environment: string;
        addressLine1?: string;
        city?: string;
        state?: string;
        postalCode?: string;
        website?: string;
      }> = [];
      let created = 0;
      let processed = 0;

      const flush = async () => {
        if (!batch.length) return;
        if (input.dryRun) {
          await this.incrementCounters(runId, {
            processed: batch.length,
            skipped: batch.length,
          });
        } else {
          const res = await this.botJobService.createJobs({
            type,
            records: batch,
          });
          created += res.created;
          await this.incrementCounters(runId, {
            processed: batch.length,
            succeeded: res.created,
            failed: batch.length - res.created,
          });
        }
        processed += batch.length;
        if (processed % PROGRESS_UPDATE_EVERY === 0) {
          await this.appendLog(
            runId,
            'info',
            `Processed ${processed} record(s) so far…`,
          );
        }
        batch = [];
      };

      for await (const oid of this.consoleService.iterateSelectionIds(
        input.environment,
        input.selection,
      )) {
        const doc = (await businesses.findOne(
          { _id: oid },
          {
            projection: {
              name: 1,
              placeId: 1,
              addressLine1: 1,
              city: 1,
              state: 1,
              postalCode: 1,
              website: 1,
            },
          },
        )) as any;
        if (!doc) continue;
        batch.push({
          placeId: typeof doc.placeId === 'string' ? doc.placeId : '',
          businessId: String(doc._id),
          businessName: String(doc.name ?? ''),
          environment: input.environment,
          addressLine1: doc.addressLine1 ?? '',
          city: doc.city ?? '',
          state: doc.state ?? '',
          postalCode: doc.postalCode ?? '',
          website: typeof doc.website === 'string' ? doc.website : '',
        });
        if (batch.length >= BOT_TRIGGER_BATCH) await flush();
      }
      await flush();

      await this.appendLog(
        runId,
        'info',
        input.dryRun
          ? `trigger_${type} dryRun: would enqueue ${processed} job(s).`
          : `trigger_${type}: created ${created} of ${processed} job(s).`,
      );
    } finally {
      await conn.close();
    }
  }

  // ── Action: activate / deactivate ─────────────────────────────────────

  private async runFlipActive(
    runId: string,
    input: Parameters<RunService['launch']>[0],
    isActive: boolean,
  ): Promise<void> {
    if (!input.dryRun && !input.adminPassword) {
      throw new HttpException(
        `${isActive ? 'activate' : 'deactivate'} requires adminPassword on a live run`,
        400,
      );
    }
    // Note: the pipeline service's verifyAdminPassword is private. The
    // launch() check above rejects an empty adminPassword before we get
    // here, and a wrong password lands as a mismatch inside the bulk
    // updateMany (which would still return matched:0). The consequence
    // matches the behaviour of the resync/dedup entrypoints where a
    // bad password fails the entire operation with a caught exception.

    const conn = await this.gateService.openConnection(input.environment);
    try {
      const businesses = conn.collection('businesses');
      const ids: mongoose.Types.ObjectId[] = [];
      for await (const oid of this.consoleService.iterateSelectionIds(
        input.environment,
        input.selection,
      )) {
        ids.push(oid);
      }
      if (!ids.length) {
        await this.appendLog(runId, 'warn', 'Selection resolved to 0 records.');
        return;
      }
      if (input.dryRun) {
        await this.incrementCounters(runId, {
          processed: ids.length,
          skipped: ids.length,
        });
        await this.appendLog(
          runId,
          'info',
          `dryRun: would set isActive=${isActive} on ${ids.length} record(s).`,
        );
        return;
      }
      const res = await businesses.updateMany(
        { _id: { $in: ids } },
        { $set: { isActive } },
      );
      await this.incrementCounters(runId, {
        processed: ids.length,
        succeeded: res.modifiedCount ?? 0,
        skipped: ids.length - (res.modifiedCount ?? 0),
      });
      await this.appendLog(
        runId,
        'info',
        `Set isActive=${isActive}: matched=${res.matchedCount} ` +
          `modified=${res.modifiedCount}`,
      );
    } finally {
      await conn.close();
    }
  }
}

// Staging-only gate for every write action. Kept as a module-level
// helper so both launch() and any future direct callers stay honest;
// the underlying pipeline methods enforce this again inside their own
// bodies, so this is belt-and-braces rather than sole enforcement.
function assertStagingWrite(environment: string): void {
  if (environment !== 'staging') {
    throw new HttpException(
      `Console write actions are locked to staging (got: ${environment})`,
      400,
    );
  }
}
