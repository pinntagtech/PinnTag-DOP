import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { randomBytes } from 'crypto';
import {
  FixBatch,
  FixBatchDocument,
  FixBatchStatus,
} from '../schemas/fix-batch.schema';
import { EmailNotifier } from './notifier';

// Per-business cascade outcome attributed back to its batch by the
// resolve webhook. Each boolean directly maps onto a counter on the
// batch doc; the webhook is responsible for computing these from the
// fresh `set` it just wrote.
export interface FixBatchOutcome {
  businessId: string;
  businessName?: string;
  hoursWritten: boolean;
  ratingWritten: boolean;
  // True when step 3 (CoverB2SyncService) reported synced OR when this
  // run skipped because the business already had a cover (operator
  // counts that as a win — no action needed).
  coverSynced: boolean;
  // True when step 2 auto-applied a mapped taxonomy on this run. The
  // 'already correct' case doesn't count — only corrections do.
  taxonomyCorrected: boolean;
  // True when the webhook returned status === 'done' AND no further
  // action is pending on this business (no pendingCoverUrl staged
  // for retry, no mismatch remaining).
  fullyFixed: boolean;
  // True when overallStatus === 'review' OR a name-mismatch / bot
  // error gate fired earlier.
  needsReview: boolean;
  reviewReason?: string;
}

const EXAMPLES_CAP = 3;

@Injectable()
export class FixBatchService {
  private readonly logger = new Logger(FixBatchService.name);

  constructor(
    @InjectModel(FixBatch.name)
    private readonly fixBatchModel: Model<FixBatchDocument>,
    private readonly notifier: EmailNotifier,
  ) {}

  // Called by triggerResolve once we know which businessIds will
  // actually be enqueued (after the skip-fully-fixed filter). Returns
  // the new batchId so the caller can surface it.
  async createBatch(args: {
    environment: string;
    businessIds: string[];
    city?: string;
    recipientEmails?: string[];
  }): Promise<FixBatchDocument | null> {
    if (!Array.isArray(args.businessIds) || args.businessIds.length === 0) {
      return null;
    }
    const batchId = generateBatchId();
    const doc = await this.fixBatchModel.create({
      batchId,
      environment: args.environment,
      city: args.city ?? '',
      businessIds: args.businessIds,
      total: args.businessIds.length,
      done: 0,
      fullyFixed: 0,
      needsReview: 0,
      counts: { hours: 0, rating: 0, cover: 0, taxonomy: 0 },
      examples: {
        fullyFixed: [], hours: [], rating: [],
        cover: [], taxonomy: [], needsReview: [],
      },
      recipientEmails: Array.isArray(args.recipientEmails)
        ? args.recipientEmails
        : [],
      status: FixBatchStatus.RUNNING,
    });
    this.logger.log(
      `[FIX-BATCH] created batch=${batchId} ` +
        `env=${args.environment} total=${doc.total}`,
    );
    return doc;
  }

  // Called by the webhook at end-of-handler. Attributes the outcome to
  // whichever open batch claims this businessId. Increments counters
  // atomically + pushes example chips up to the cap. When done == total
  // a SECOND atomic update flips status to 'complete' (guarded so only
  // one concurrent caller wins) and fires the notifier.
  async recordOutcome(outcome: FixBatchOutcome): Promise<void> {
    // Find the most recent open batch containing this businessId. Most
    // resolve calls come from one batch at a time; older "running"
    // batches are matched only if they still hold this id, which is
    // fine because outcomes are attributed once.
    const batch = await this.fixBatchModel
      .findOne({
        status: FixBatchStatus.RUNNING,
        businessIds: outcome.businessId,
      })
      .sort({ createdAt: -1 });
    if (!batch) return;

    const inc: Record<string, number> = { done: 1 };
    if (outcome.fullyFixed) inc.fullyFixed = 1;
    if (outcome.needsReview) inc.needsReview = 1;
    if (outcome.hoursWritten) inc['counts.hours'] = 1;
    if (outcome.ratingWritten) inc['counts.rating'] = 1;
    if (outcome.coverSynced) inc['counts.cover'] = 1;
    if (outcome.taxonomyCorrected) inc['counts.taxonomy'] = 1;

    // Push examples up to a hard cap (3 per bucket). Mongo's $push +
    // $slice would do this in one update, but the buckets are
    // independent and we only push when there's room. JS-side filter
    // is simpler and still costs one updateOne.
    const exampleEntry = {
      businessId: outcome.businessId,
      businessName: outcome.businessName ?? '',
      reason: outcome.reviewReason ?? '',
    };
    const push: Record<string, any> = {};
    const ex = batch.examples;
    if (outcome.fullyFixed && (ex.fullyFixed?.length ?? 0) < EXAMPLES_CAP) {
      push['examples.fullyFixed'] = exampleEntry;
    }
    if (outcome.hoursWritten && (ex.hours?.length ?? 0) < EXAMPLES_CAP) {
      push['examples.hours'] = exampleEntry;
    }
    if (outcome.ratingWritten && (ex.rating?.length ?? 0) < EXAMPLES_CAP) {
      push['examples.rating'] = exampleEntry;
    }
    if (outcome.coverSynced && (ex.cover?.length ?? 0) < EXAMPLES_CAP) {
      push['examples.cover'] = exampleEntry;
    }
    if (
      outcome.taxonomyCorrected &&
      (ex.taxonomy?.length ?? 0) < EXAMPLES_CAP
    ) {
      push['examples.taxonomy'] = exampleEntry;
    }
    if (
      outcome.needsReview &&
      (ex.needsReview?.length ?? 0) < EXAMPLES_CAP
    ) {
      push['examples.needsReview'] = exampleEntry;
    }

    const update: Record<string, any> = { $inc: inc };
    if (Object.keys(push).length > 0) update.$push = push;

    const updated = await this.fixBatchModel.findOneAndUpdate(
      { _id: batch._id, status: FixBatchStatus.RUNNING },
      update,
      { new: true },
    );
    if (!updated) return; // batch already flipped to 'complete' by a
                          // racing caller — nothing left to do.

    if (updated.done >= updated.total) {
      // Atomic dedupe: only one caller flips RUNNING → COMPLETE for
      // this batch, even under parallel webhook delivery. The notifier
      // fires off the winning update so it can never be re-sent.
      const finalized = await this.fixBatchModel.findOneAndUpdate(
        { _id: updated._id, status: FixBatchStatus.RUNNING },
        {
          $set: {
            status: FixBatchStatus.COMPLETE,
            completedAt: new Date(),
          },
        },
        { new: true },
      );
      if (finalized) {
        this.logger.log(
          `[FIX-BATCH] complete batch=${finalized.batchId} ` +
            `fullyFixed=${finalized.fullyFixed}/` +
            `${finalized.total} ` +
            `needsReview=${finalized.needsReview}`,
        );
        // Notifier is decoupled — its own try/catch logs failures
        // without surfacing back here. The fix pipeline already
        // succeeded by the time we got here.
        await this.notifier.sendBatchSummary(finalized);
      }
    }
  }
}

// Short, sortable, human-friendly batchId: 'fixb-YYYYMMDD-<hex8>'.
// Stable enough to surface in the email subject + portal deep-link
// without being mistaken for a Mongo ObjectId.
function generateBatchId(): string {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  const rand = randomBytes(4).toString('hex');
  return `fixb-${yyyy}${mm}${dd}-${rand}`;
}
