import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import mongoose from 'mongoose';
import { SeedingSessionService } from '../seeding-session.service';
import { BotJobService } from '../bot/bot-job.service';
import { BotJobType } from '../schemas/bot-job.schema';
import {
  EnvironmentUriKey,
  SeedingEnvironments,
  SeedingSessionType,
} from '../../../common/constants';
import { Exceptions } from '../../../common/errors';
import { seededCohortOrClause } from '../common/seeded-cohort';
import { PLACEHOLDER_COVER_REGEX } from '../activation/seed-defaults';

const BACKFILL_ENV = SeedingEnvironments.STAGING;
const BACKFILL_BATCH = 500;
const BACKFILL_CANDIDATE_WINDOW = 1500;
const BACKFILL_SESSION_NAME = 'Cover Backfill';

// Coverless = seeded cohort, has a placeId, AND cover is one of:
//   - missing / empty / null
//   - a pinntag-assets Defaults/* placeholder URL (previously blocked
//     these from ever earning a real cover because the backend supplies
//     the placeholder at seed time, so `cover` was non-empty).
// Reused by getStats() and queueBatch() so the two endpoints can never
// disagree on what "coverless" means.
const coverlessFilter: Record<string, any> = {
  $and: [
    { $or: seededCohortOrClause() },
    {
      $or: [
        { cover: { $exists: false } },
        { cover: '' },
        { cover: null },
        { cover: PLACEHOLDER_COVER_REGEX },
      ],
    },
    { placeId: { $exists: true, $nin: ['', null] } },
  ],
};

@Injectable()
export class CoverBackfillService {
  private readonly logger = new Logger(CoverBackfillService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly sessionService: SeedingSessionService,
    private readonly botJobService: BotJobService,
  ) {}

  async getStats(): Promise<{
    environment: string;
    totalCoverless: number;
    inFlight: number;
    batchSize: number;
  }> {
    const conn = await this.openTargetConn();
    try {
      const Businesses = conn.collection('businesses');

      const totalCoverless = await Businesses.countDocuments(coverlessFilter);

      // Pull candidate ids so we can ask BotJobService (DOP-internal DB)
      // which are already enqueued. Cap to a generous window — operators
      // only care about an approximate in-flight count for the header.
      const candidates = await Businesses.find(coverlessFilter, {
        projection: { _id: 1 },
      })
        .limit(BACKFILL_CANDIDATE_WINDOW)
        .toArray();

      const candidateIds = candidates.map((b) => String(b._id));
      const inflight = await this.botJobService.findInflightBusinessIds(
        BotJobType.COVER_SYNC,
        candidateIds,
      );

      return {
        environment: BACKFILL_ENV,
        totalCoverless,
        inFlight: inflight.size,
        batchSize: BACKFILL_BATCH,
      };
    } finally {
      await conn.close();
    }
  }

  async queueBatch(actor: string): Promise<{
    queued: number;
    requested: number;
    skippedInFlight: number;
    remainingCoverless: number;
  }> {
    const sessionId = await this.resolveBackfillSessionId(actor);

    const conn = await this.openTargetConn();
    try {
      const Businesses = conn.collection('businesses');

      const candidates = await Businesses.find(coverlessFilter, {
        projection: { _id: 1, name: 1, placeId: 1 },
      })
        .sort({ _id: 1 })
        .limit(BACKFILL_CANDIDATE_WINDOW)
        .toArray();

      const candidateIds = candidates.map((b) => String(b._id));
      const inflight = await this.botJobService.findInflightBusinessIds(
        BotJobType.COVER_SYNC,
        candidateIds,
      );

      const eligible = candidates.filter(
        (b) =>
          !inflight.has(String(b._id)) &&
          !!(b.name && String(b.name).trim()) &&
          !!(b.placeId && String(b.placeId).trim()),
      );
      const batch = eligible.slice(0, BACKFILL_BATCH);

      const records = batch.map((b) => ({
        placeId: String(b.placeId),
        businessId: String(b._id),
        businessName: String(b.name),
        environment: BACKFILL_ENV,
        maxReviews: 100,
      }));

      let created = 0;
      if (records.length) {
        const result = await this.botJobService.createJobs({
          records,
          sessionId,
          type: BotJobType.COVER_SYNC,
        });
        created = result.created;
      }

      const remainingCoverless = await Businesses.countDocuments(
        coverlessFilter,
      );

      this.logger.log(
        `[COVER-BACKFILL] actor=${actor} queued=${created} ` +
          `requested=${records.length} skippedInFlight=${inflight.size} ` +
          `remaining=${remainingCoverless}`,
      );

      return {
        queued: created,
        requested: records.length,
        skippedInFlight: inflight.size,
        remainingCoverless,
      };
    } finally {
      await conn.close();
    }
  }

  private async openTargetConn(): Promise<mongoose.Connection> {
    const uriKey = EnvironmentUriKey[BACKFILL_ENV];
    const uri = this.configService.get<string>(uriKey);
    if (!uri) throw Exceptions.publishTargetMissing(BACKFILL_ENV);
    return mongoose.createConnection(uri).asPromise();
  }

  private async resolveBackfillSessionId(actor: string): Promise<string> {
    const existing = await this.sessionService.findAll({
      environment: BACKFILL_ENV,
    });
    const match = existing.find((s) => s.name === BACKFILL_SESSION_NAME);
    if (match) return String(match._id);

    const created = await this.sessionService.create({
      name: BACKFILL_SESSION_NAME,
      environment: BACKFILL_ENV,
      createdBy: actor,
      type: SeedingSessionType.STANDARD,
    });
    return String(created._id);
  }
}
