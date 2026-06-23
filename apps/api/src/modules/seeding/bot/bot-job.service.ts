import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import mongoose, { Model } from 'mongoose';
import {
  BotJob,
  BotJobDocument,
  BotJobStatus,
  BotJobType,
} from '../schemas/bot-job.schema';
import { SeedingSessionService } from '../seeding-session.service';

const BOT_JOB_TYPE_TO_BUCKET: Record<
  BotJobType,
  'reviews' | 'galleryMenu' | 'imageSync' | 'coverSync'
> = {
  [BotJobType.GALLERY_MENU]: 'galleryMenu',
  [BotJobType.REVIEWS]: 'reviews',
  [BotJobType.IMAGE_SYNC]: 'imageSync',
  [BotJobType.COVER_SYNC]: 'coverSync',
  [BotJobType.RESOLVE_BUSINESS]: 'reviews',
};

@Injectable()
export class BotJobService {
  private readonly logger = new Logger(BotJobService.name);

  constructor(
    @InjectModel(BotJob.name)
    private readonly botJobModel: Model<BotJobDocument>,
    private readonly sessionService: SeedingSessionService,
  ) {}

  async createJobs(payload: {
    records: {
      placeId: string;
      businessId: string;
      businessName: string;
      environment: string;
      maxReviews?: number;
      // Address fields are required for RESOLVE_BUSINESS jobs (used to
      // build the Google Maps search URL when a valid ChIJ placeId
      // isn't on record yet). Other job types ignore them.
      addressLine1?: string;
      city?: string;
      state?: string;
      postalCode?: string;
    }[];
    // Optional: RESOLVE_BUSINESS jobs aren't bound to a seeding session
    // (they run from the operator-triggered resolve queue), so they
    // carry no sessionId. Every other job type is created from a
    // session controller and passes the session id through.
    sessionId?: string;
    type: BotJobType;
  }): Promise<{ created: number }> {
    // resolve_business jobs may legitimately have an empty placeId
    // (the schema default '' is allowed) — the bot will fall back to
    // address-only search. For every other type, an absent placeId is
    // a scrape miss and we drop the record rather than enqueue a bad
    // job. The businessId requirement is universal.
    const docs = payload.records
      .filter((r) =>
        r.businessId &&
        (r.placeId || payload.type === BotJobType.RESOLVE_BUSINESS),
      )
      .map((r) => ({
        placeId: r.placeId ?? '',
        businessId: r.businessId,
        businessName: r.businessName,
        environment: r.environment,
        sessionId: payload.sessionId ?? '',
        type: payload.type,
        status: BotJobStatus.PENDING,
        maxReviews: r.maxReviews || 100,
        addressLine1: r.addressLine1 ?? '',
        city: r.city ?? '',
        state: r.state ?? '',
        postalCode: r.postalCode ?? '',
        attempts: 0,
      }));

    await this.botJobModel.insertMany(docs);
    this.logger.log(`[JOBS] Created ${docs.length} ${payload.type} jobs`);
    return { created: docs.length };
  }

  async claimNextJob(
    type?: BotJobType,
    excludeTypes?: BotJobType[],
  ): Promise<BotJobDocument | null> {
    // Caller contract:
    //   claimNextJob(type)              → pin to that type
    //   claimNextJob(undefined, [...])  → claim any pending job
    //                                     EXCEPT the listed types
    //   claimNextJob()                  → claim any pending job
    // The single-job /bot/poll endpoint uses the exclude form to keep
    // RESOLVE_BUSINESS off the single-worker queue (its parallel pool
    // owns those via /bot/poll-batch).
    const query: Record<string, any> = {
      status: BotJobStatus.PENDING,
      attempts: { $lt: 3 },
    };
    if (type) {
      query.type = type;
    } else if (excludeTypes && excludeTypes.length > 0) {
      query.type = { $nin: excludeTypes };
    }

    const job = await this.botJobModel.findOneAndUpdate(
      query,
      {
        $set: {
          status: BotJobStatus.RUNNING,
          claimedAt: new Date(),
        },
        $inc: { attempts: 1 },
      },
      {
        new: true,
        sort: { createdAt: 1 },
      },
    );

    if (job) {
      this.logger.log(
        `[JOBS] Claimed job ${job._id} — ${job.type} for ${job.businessName}`,
      );
    }

    return job;
  }

  // Atomic batch claim for the resolve_business parallel worker pool.
  // Loops claimNextJob up to `limit` times — per-job findOneAndUpdate is
  // race-safe and bounded by how many pending jobs of that type exist.
  // Returns the actually-claimed jobs (may be shorter than limit).
  async claimNextJobs(
    type: BotJobType,
    limit: number,
  ): Promise<BotJobDocument[]> {
    const n = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 1;
    const claimed: BotJobDocument[] = [];
    for (let i = 0; i < n; i++) {
      const job = await this.claimNextJob(type);
      if (!job) break;
      claimed.push(job);
    }
    return claimed;
  }

  async completeJob(
    jobId: string,
    result: { success: boolean; error?: string },
  ): Promise<void> {
    const job = await this.botJobModel
      .findById(new mongoose.Types.ObjectId(jobId))
      .lean();

    await this.botJobModel.updateOne(
      { _id: new mongoose.Types.ObjectId(jobId) },
      {
        $set: {
          status: result.success ? BotJobStatus.DONE : BotJobStatus.FAILED,
          completedAt: new Date(),
          error: result.error || null,
        },
      },
    );

    if (job?.sessionId) {
      const bucket = BOT_JOB_TYPE_TO_BUCKET[job.type as BotJobType];
      if (bucket) {
        try {
          await this.sessionService.incrementBotOperation(
            job.sessionId,
            bucket,
            result.success,
          );
        } catch (err: any) {
          this.logger.warn(
            `[JOBS] Failed to update session botOperations: ${err.message}`,
          );
        }
      }
    }
  }

  // Pending + running jobs for a session, shape matching the portal's
  // ActiveBotJob (packages/types). Newest first so the session detail
  // page surfaces the most recently enqueued work at the top.
  async getActiveSessionJobs(sessionId: string): Promise<Array<{
    businessId: string;
    businessName: string;
    type: BotJobType;
    status: BotJobStatus;
    createdAt: string;
    attempts: number;
  }>> {
    const jobs = await this.botJobModel
      .find({
        sessionId,
        status: { $in: [BotJobStatus.PENDING, BotJobStatus.RUNNING] },
      })
      .sort({ createdAt: -1 })
      .lean();
    return (jobs as any[]).map((j) => ({
      businessId: j.businessId,
      businessName: j.businessName,
      type: j.type as BotJobType,
      status: j.status as BotJobStatus,
      createdAt:
        j.createdAt instanceof Date
          ? j.createdAt.toISOString()
          : String(j.createdAt ?? ''),
      attempts: j.attempts ?? 0,
    }));
  }

  async getSessionJobStats(sessionId: string): Promise<{
    pending: number;
    running: number;
    done: number;
    failed: number;
  }> {
    const stats = await this.botJobModel.aggregate([
      { $match: { sessionId } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]);

    const result = { pending: 0, running: 0, done: 0, failed: 0 };
    for (const s of stats) {
      result[s._id as keyof typeof result] = s.count;
    }
    return result;
  }

  async resetStuckJobs(): Promise<number> {
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    const result = await this.botJobModel.updateMany(
      {
        status: BotJobStatus.RUNNING,
        claimedAt: { $lt: tenMinutesAgo },
        attempts: { $lt: 3 },
      },
      {
        $set: { status: BotJobStatus.PENDING },
      },
    );
    return result.modifiedCount;
  }
}
