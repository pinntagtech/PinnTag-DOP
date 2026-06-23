import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import mongoose, { Model } from 'mongoose';
import {
  EnvironmentUriKey,
  SeedingModules,
  SeedingRecordStatus,
} from '../../../common/constants';
import {
  SeedingRecord,
  SeedingRecordDocument,
} from '../schemas/seeding-record.schema';
import {
  CoverageSnapshot,
  CoverageSnapshotDocument,
} from '../schemas/coverage-snapshot.schema';
import { DbSyncService } from '../sync/db-sync.service';

// FIFA 2026 US host metros — fixed real-world reference, not a metric.
export const HOST_METROS_COUNT = 11;

const UNKNOWN_CITY = 'Unknown';

const LOOSE_SCHEMA = new mongoose.Schema<any>(
  {},
  { strict: false, timestamps: true },
);

@Injectable()
export class CoverageService {
  private readonly logger = new Logger(CoverageService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly dbSyncService: DbSyncService,
    @InjectModel(SeedingRecord.name)
    private readonly recordModel: Model<SeedingRecordDocument>,
    @InjectModel(CoverageSnapshot.name)
    private readonly snapshotModel: Model<CoverageSnapshotDocument>,
  ) {}

  // Same mechanism reset / migrate / db-sync use.
  private resolveTargetUri(environment: string): string {
    const uriKey =
      EnvironmentUriKey[environment as keyof typeof EnvironmentUriKey];
    if (!uriKey) {
      throw new Error(`Unknown environment: ${environment}`);
    }
    const uri = this.configService.get<string>(uriKey);
    if (!uri) {
      throw new Error(`No URI configured for: ${environment}`);
    }
    return uri;
  }

  async computeSnapshot(actorId: string): Promise<CoverageSnapshotDocument> {
    // ── DOP-side aggregates (over seedingrecords) ────────────────────────
    const groupPipeline: mongoose.PipelineStage[] = [
      { $match: { module: SeedingModules.BUSINESS } },
      {
        $group: {
          _id: {
            $cond: [
              {
                $or: [
                  { $eq: ['$transformedData.city', null] },
                  { $eq: ['$transformedData.city', ''] },
                  { $eq: [{ $type: '$transformedData.city' }, 'missing'] },
                ],
              },
              null,
              '$transformedData.city',
            ],
          },
          total: { $sum: 1 },
          published: {
            $sum: {
              $cond: [
                { $eq: ['$status', SeedingRecordStatus.PUBLISHED] },
                1,
                0,
              ],
            },
          },
          // Pick the first non-empty state we see for this city.
          state: {
            $first: {
              $cond: [
                {
                  $or: [
                    { $eq: ['$transformedData.state', null] },
                    { $eq: ['$transformedData.state', ''] },
                  ],
                },
                null,
                '$transformedData.state',
              ],
            },
          },
        },
      },
      { $sort: { total: -1 } },
    ];

    type GroupRow = {
      _id: string | null;
      total: number;
      published: number;
      state: string | null;
    };
    const groupRows = (await this.recordModel.aggregate(
      groupPipeline,
    )) as GroupRow[];

    const byCity = groupRows.map((g) => {
      const city = g._id ?? UNKNOWN_CITY;
      const total = g.total ?? 0;
      const published = g.published ?? 0;
      return {
        city,
        state: g.state ?? null,
        total,
        published,
        pending: Math.max(0, total - published),
      };
    });

    let seeded = 0;
    let published = 0;
    let citiesCovered = 0;
    for (const c of byCity) {
      seeded += c.total;
      published += c.published;
      if (c.city !== UNKNOWN_CITY) citiesCovered++;
    }
    const publishRate = seeded > 0 ? Math.round((published / seeded) * 100) : 0;

    const citySharePublished = byCity
      .filter((c) => c.published > 0)
      .map((c) => ({ city: c.city, published: c.published }))
      .sort((a, b) => b.published - a.published);

    // ── Prod-side count (over the publishedId scope) ─────────────────────
    let liveInProduction: number | null = null;
    let prodConnectionError: string | null = null;

    try {
      const prodScope = await this.dbSyncService.resolveScope('production');
      const publishedOids = prodScope
        .map((s) => s.publishedId)
        .filter((id) => mongoose.isValidObjectId(id))
        .map((id) => new mongoose.Types.ObjectId(id));

      if (publishedOids.length === 0) {
        liveInProduction = 0;
      } else {
        const prodUri = this.resolveTargetUri('production');
        const conn = await mongoose.createConnection(prodUri).asPromise();
        try {
          const BusinessModel =
            conn.models['Business'] ||
            conn.model('Business', LOOSE_SCHEMA, 'businesses');
          liveInProduction = await BusinessModel.countDocuments({
            _id: { $in: publishedOids },
          });
        } finally {
          await conn.close();
        }
      }
    } catch (err: any) {
      prodConnectionError = err?.message ?? String(err);
      liveInProduction = null;
      this.logger.warn(
        `[COVERAGE] prod count unavailable: ${prodConnectionError}`,
      );
    }

    // ── Persist + return ─────────────────────────────────────────────────
    const snapshot = await this.snapshotModel.create({
      generatedAt: new Date(),
      generatedBy: actorId,
      totals: {
        seeded,
        published,
        publishRate,
        liveInProduction,
        citiesCovered,
        hostMetros: HOST_METROS_COUNT,
      },
      byCity,
      prodVsStaging: {
        published,
        liveInProduction,
      },
      citySharePublished,
      prodConnectionError,
    });

    return snapshot;
  }

  async getLatest(): Promise<CoverageSnapshotDocument | null> {
    return this.snapshotModel
      .findOne()
      .sort({ generatedAt: -1 })
      .exec();
  }

  // GET endpoint convenience: compute on the fly if we've never snapshotted.
  async getOrCompute(actorId: string): Promise<CoverageSnapshotDocument> {
    const latest = await this.getLatest();
    if (latest) return latest;
    return this.computeSnapshot(actorId);
  }
}
