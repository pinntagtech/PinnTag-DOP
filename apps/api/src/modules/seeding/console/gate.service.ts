import { HttpException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import mongoose from 'mongoose';
import { EnvironmentUriKey } from '../../../common/constants';
import {
  evaluateAllGates,
  GATE_CRITERIA,
  GateBooleans,
} from './gate-predicates';
import { buildSeededFilter } from '../common/seeded-cohort';

const RECOMPUTE_BATCH_SIZE = 500;

// Fields the gate reads. Keeping the projection small matters at 100k+
// docs — some seeded businesses have heavy embedded arrays we don't
// need to stream through the driver just to compute booleans.
const RECOMPUTE_PROJECTION = {
  _id: 1,
  isActive: 1,
  activatedOutletsLength: 1,
  cover: 1,
  resolveStatus: 1,
  businessIndustry: 1,
  businessCategories: 1,
  addressLine1: 1,
  city: 1,
  placeId: 1,
  latitude: 1,
  longitude: 1,
  lat: 1,
  lng: 1,
  location: 1,
  country: 1,
  emailVerification: 1,
} as const;

export interface GateRecomputeResult {
  environment: string;
  scanned: number;
  updated: number;
  duplicatePlaceIds: number;
  durationMs: number;
  computedAt: string;
  totals: {
    passLegacy9: number;
    passPerfect11: number;
    failByCriterion: Record<string, number>;
  };
}

export interface GateFreshness {
  environment: string;
  oldestComputedAt: string | null;
  newestComputedAt: string | null;
  gatedCount: number;
  ungatedCount: number;
}

@Injectable()
export class GateService {
  private readonly logger = new Logger(GateService.name);

  constructor(private readonly configService: ConfigService) {}

  // ── Env resolution ────────────────────────────────────────────────────
  private resolveTargetUri(environment: string): string {
    const uriKey =
      EnvironmentUriKey[environment as keyof typeof EnvironmentUriKey];
    const uri = uriKey
      ? this.configService.get<string>(uriKey)
      : undefined;
    if (!uri) {
      throw new HttpException(
        `No database URI configured for environment: ${environment}`,
        400,
      );
    }
    return uri;
  }

  // Public helper so ConsoleService reuses the same URI-resolution +
  // connection-open path.
  async openConnection(environment: string): Promise<mongoose.Connection> {
    const uri = this.resolveTargetUri(environment);
    return mongoose.createConnection(uri).asPromise();
  }

  // ── Freshness ─────────────────────────────────────────────────────────
  //
  // Reports oldest and newest gateStatus.computedAt across the seeded
  // corpus so the UI can show staleness. Also splits total vs.
  // never-computed so a first-run env is obvious ("N never gated").
  async freshness(environment: string): Promise<GateFreshness> {
    const conn = await this.openConnection(environment);
    try {
      const businesses = conn.collection('businesses');
      const [agg] = (await businesses
        .aggregate([
          { $match: buildSeededFilter() },
          {
            $group: {
              _id: null,
              oldest: { $min: '$gateStatus.computedAt' },
              newest: { $max: '$gateStatus.computedAt' },
              total: { $sum: 1 },
              gated: {
                $sum: {
                  $cond: [
                    { $ifNull: ['$gateStatus.computedAt', false] },
                    1,
                    0,
                  ],
                },
              },
            },
          },
        ])
        .toArray()) as Array<{
        oldest?: Date;
        newest?: Date;
        total: number;
        gated: number;
      }>;

      const total = agg?.total ?? 0;
      const gated = agg?.gated ?? 0;
      return {
        environment,
        oldestComputedAt: agg?.oldest ? agg.oldest.toISOString() : null,
        newestComputedAt: agg?.newest ? agg.newest.toISOString() : null,
        gatedCount: gated,
        ungatedCount: total - gated,
      };
    } finally {
      await conn.close();
    }
  }

  // ── Recompute ─────────────────────────────────────────────────────────
  //
  // One recompute pass over the seeded corpus in `environment`.
  //
  // Pass 1: build a `placeId -> count` map with a single aggregation. c6
  // needs this shared across every doc; computing it per-doc would be
  // O(n^2). Uses allowDiskUse so it doesn't OOM on large corpora.
  //
  // Pass 2: stream a cursor over seeded docs (projection above),
  // evaluate every criterion, and bulkWrite gateStatus back in batches
  // of RECOMPUTE_BATCH_SIZE. Idempotent — same input → same gateStatus.
  //
  // Runs synchronously within the request for Phase A. If a corpus ever
  // grows to a size where the request times out, promote this into a
  // background run — the entry point stays the same.
  async recompute(environment: string): Promise<GateRecomputeResult> {
    const start = Date.now();
    const conn = await this.openConnection(environment);
    try {
      const businesses = conn.collection('businesses');

      await this.ensureIndexes(businesses);

      // Pass 1 — placeId count map for c6.
      const placeIdCounts = new Map<string, number>();
      const placeIdCursor = businesses.aggregate(
        [
          {
            $match: {
              ...buildSeededFilter(),
              placeId: { $type: 'string', $ne: '' },
            },
          },
          { $group: { _id: '$placeId', count: { $sum: 1 } } },
        ],
        { allowDiskUse: true },
      );
      let duplicatePlaceIds = 0;
      for await (const g of placeIdCursor) {
        const pid = String(g._id).trim();
        if (!pid) continue;
        placeIdCounts.set(pid, g.count);
        if (g.count > 1) duplicatePlaceIds++;
      }

      // Pass 2 — evaluate + persist.
      let scanned = 0;
      let updated = 0;
      let passLegacy9 = 0;
      let passPerfect11 = 0;
      const failByCriterion: Record<string, number> = {};
      for (const c of GATE_CRITERIA) failByCriterion[c] = 0;

      const cursor = businesses.find(buildSeededFilter(), {
        projection: RECOMPUTE_PROJECTION,
      });
      const computedAt = new Date();
      let batch: mongoose.mongo.AnyBulkWriteOperation[] = [];

      const flush = async () => {
        if (!batch.length) return;
        const res = await businesses.bulkWrite(batch, { ordered: false });
        updated += res.modifiedCount ?? 0;
        batch = [];
      };

      for await (const doc of cursor) {
        scanned++;
        const gates: GateBooleans = evaluateAllGates(
          doc as Record<string, any>,
          placeIdCounts,
        );
        if (gates.passLegacy9) passLegacy9++;
        if (gates.passPerfect11) passPerfect11++;
        for (const c of GATE_CRITERIA) {
          if (!gates[c]) failByCriterion[c]++;
        }
        batch.push({
          updateOne: {
            filter: { _id: doc._id as unknown as mongoose.Types.ObjectId },
            update: { $set: { gateStatus: { ...gates, computedAt } } },
          },
        });
        if (batch.length >= RECOMPUTE_BATCH_SIZE) {
          await flush();
        }
      }
      await flush();

      const durationMs = Date.now() - start;
      this.logger.log(
        `[GATE] recompute env=${environment} scanned=${scanned} ` +
          `updated=${updated} passLegacy9=${passLegacy9} ` +
          `passPerfect11=${passPerfect11} dupPlaceIds=${duplicatePlaceIds} ` +
          `durationMs=${durationMs}`,
      );

      return {
        environment,
        scanned,
        updated,
        duplicatePlaceIds,
        durationMs,
        computedAt: computedAt.toISOString(),
        totals: { passLegacy9, passPerfect11, failByCriterion },
      };
    } finally {
      await conn.close();
    }
  }

  // Idempotent createIndex calls on the target env's `businesses`
  // collection. The DOP-local BusinessSchema already declares these
  // indexes for its own connection; cross-env collections need to be
  // ensured separately because we open them with strict:false raw
  // connections rather than a modelled Mongoose connection.
  private async ensureIndexes(
    businesses: mongoose.mongo.Collection,
  ): Promise<void> {
    const specs: Array<{ key: Record<string, 1 | -1>; name: string }> = [
      { key: { placeId: 1 }, name: 'placeId_1' },
      { key: { city: 1 }, name: 'city_1' },
      { key: { state: 1 }, name: 'state_1' },
      { key: { isCvb: 1 }, name: 'isCvb_1' },
      { key: { isFromCrawler: 1 }, name: 'isFromCrawler_1' },
      { key: { 'gateStatus.passLegacy9': 1 }, name: 'gateStatus_passLegacy9_1' },
      {
        key: { 'gateStatus.passPerfect11': 1 },
        name: 'gateStatus_passPerfect11_1',
      },
    ];
    for (const c of GATE_CRITERIA) {
      specs.push({
        key: { [`gateStatus.${c}`]: 1 } as Record<string, 1 | -1>,
        name: `gateStatus_${c}_1`,
      });
    }
    for (const s of specs) {
      try {
        await businesses.createIndex(s.key, { name: s.name });
      } catch (err: any) {
        // createIndex is idempotent but throws on incompatible existing
        // definitions (different options, name collision). Indexes are
        // perf, not correctness — log and continue.
        this.logger.warn(
          `[GATE] createIndex ${s.name} failed: ${err?.message ?? err}`,
        );
      }
    }
  }
}
