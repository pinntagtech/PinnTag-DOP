import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import mongoose, { Model } from 'mongoose';
import {
  SeedingSession,
  SeedingSessionDocument,
} from './schemas/seeding-session.schema';
import {
  SeedingRecord,
  SeedingRecordDocument,
} from './schemas/seeding-record.schema';
import { CreateSeedingSessionDto } from './dto/create-seeding-session.dto';
import { SeedingLogService } from './seeding-log.service';
import {
  SeedingSessionStatus,
  SeedingLogActions,
  SeedingLogMessages,
  SeedingDefaults,
} from '../../common/constants';
import { Exceptions } from '../../common/errors';
import { validateObjectId } from '../../common/utils';

@Injectable()
export class SeedingSessionService {
  constructor(
    @InjectModel(SeedingSession.name)
    private readonly sessionModel: Model<SeedingSessionDocument>,
    @InjectModel(SeedingRecord.name)
    private readonly recordModel: Model<SeedingRecordDocument>,
    private readonly logService: SeedingLogService,
  ) {}

  async create(dto: CreateSeedingSessionDto): Promise<SeedingSessionDocument> {
    const session = new this.sessionModel(dto);
    await session.save();

    await this.logService.log({
      sessionId: String(session._id),
      action: SeedingLogActions.CREATED,
      actor: dto.createdBy ?? 'Operator',
      toStatus: SeedingSessionStatus.DRAFT,
      message: SeedingLogMessages.sessionCreated(dto.name, dto.environment),
    });

    return session;
  }

  async findAll(filters: {
    environment?: string;
    status?: string;
    createdBy?: string;
  }): Promise<SeedingSessionDocument[]> {
    const query: Record<string, any> = {};
    if (filters.environment) query.environment = filters.environment;
    if (filters.status) query.status = filters.status;
    if (filters.createdBy) query.createdBy = filters.createdBy;
    return this.sessionModel
      .find(query)
      .sort(SeedingDefaults.SORT_ORDER)
      .exec();
  }

  async findById(id: string): Promise<SeedingSessionDocument> {
    validateObjectId(id, 'sessionId');
    const session = await this.sessionModel.findById(id).exec();
    if (!session) throw Exceptions.sessionNotFound(id);
    return session;
  }

  async findBySessionId(sessionId: string): Promise<SeedingSessionDocument> {
    const session = await this.sessionModel.findOne({ sessionId }).exec();
    if (!session) throw Exceptions.sessionNotFound(sessionId);
    return session;
  }

  async updateStatus(
    id: string,
    status: string,
    actor: string,
  ): Promise<SeedingSessionDocument> {
    const session = await this.findById(id);
    const fromStatus = session.status;

    session.status = status;
    await session.save();

    await this.logService.log({
      sessionId: id,
      action: SeedingLogActions.STATUS_CHANGED,
      actor,
      fromStatus,
      toStatus: status,
      message: SeedingLogMessages.statusChanged(fromStatus, status),
    });

    return session;
  }

  async updateStats(id: string): Promise<void> {
    const results = await this.recordModel
      .aggregate([
        { $match: { sessionId: (await this.findById(id))._id } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ])
      .exec();

    const stats: Record<string, number> = { ...SeedingDefaults.STATS };
    let total = 0;
    for (const r of results) {
      stats[r._id] = r.count;
      total += r.count;
    }

    await this.sessionModel
      .findByIdAndUpdate(id, { stats, totalRecords: total })
      .exec();
  }

  async cancel(id: string, actor: string): Promise<SeedingSessionDocument> {
    return this.updateStatus(id, SeedingSessionStatus.CANCELLED, actor);
  }

  async updateById(
    id: string,
    update: Record<string, any>,
  ): Promise<void> {
    await this.sessionModel.updateOne(
      { _id: new mongoose.Types.ObjectId(id) },
      { $set: update },
    );
  }

  async delete(id: string): Promise<void> {
    validateObjectId(id, 'sessionId');
    const result = await this.sessionModel.findByIdAndDelete(id).exec();
    if (!result) throw Exceptions.sessionNotFound(id);
  }

  async pushMigratedTo(
    sessionId: string,
    entry: {
      environment: string;
      sessionId: string | mongoose.Types.ObjectId;
      migratedAt: Date;
    },
  ): Promise<void> {
    validateObjectId(sessionId, 'sessionId');
    await this.sessionModel.updateOne(
      { _id: new mongoose.Types.ObjectId(sessionId) },
      {
        $push: {
          migratedTo: {
            environment: entry.environment,
            sessionId:
              typeof entry.sessionId === 'string'
                ? new mongoose.Types.ObjectId(entry.sessionId)
                : entry.sessionId,
            migratedAt: entry.migratedAt,
          },
        },
      },
    );
  }

  async getCoverageAnalytics(filters: { environment?: string } = {}): Promise<{
    totals: {
      totalRecords: number;
      published: number;
      inProd: number;
      cities: number;
      publishRate: number;
    };
    byCity: {
      city: string;
      state: string | null;
      total: number;
      published: number;
      pending: number;
    }[];
    prodSplit: { live: number; staging: number };
    byState: { state: string; published: number }[];
  }> {
    const match: Record<string, any> = {};
    if (filters.environment) match.environment = filters.environment;

    const sessions = await this.sessionModel
      .find(match, {
        dominantCity: 1,
        dominantState: 1,
        totalRecords: 1,
        'stats.published': 1,
        migratedTo: 1,
      })
      .lean();

    const isProd = (s: any) =>
      Array.isArray(s.migratedTo) &&
      s.migratedTo.some(
        (m: any) => m?.environment === 'production' || m?.environment === 'prod',
      );

    const byCityMap = new Map<
      string,
      { city: string; state: string | null; total: number; published: number }
    >();
    const byStateMap = new Map<string, number>();

    let totalRecords = 0;
    let published = 0;
    let prodLive = 0;

    for (const s of sessions) {
      const total = (s as any).totalRecords ?? 0;
      const pub = (s as any).stats?.published ?? 0;
      totalRecords += total;
      published += pub;
      if (isProd(s)) prodLive += pub;

      const city = (s as any).dominantCity as string | null;
      const state = ((s as any).dominantState as string | null) ?? null;

      if (city && total > 0) {
        const key = city;
        const prev = byCityMap.get(key) ?? {
          city,
          state,
          total: 0,
          published: 0,
        };
        prev.total += total;
        prev.published += pub;
        if (!prev.state && state) prev.state = state;
        byCityMap.set(key, prev);
      }

      if (state && pub > 0) {
        byStateMap.set(state, (byStateMap.get(state) ?? 0) + pub);
      }
    }

    const byCity = Array.from(byCityMap.values())
      .filter((c) => c.total > 0)
      .map((c) => ({ ...c, pending: Math.max(0, c.total - c.published) }))
      .sort((a, b) => b.total - a.total);

    const byState = Array.from(byStateMap.entries())
      .map(([state, p]) => ({ state, published: p }))
      .sort((a, b) => b.published - a.published);

    const publishRate =
      totalRecords > 0 ? Math.round((published / totalRecords) * 100) : 0;

    return {
      totals: {
        totalRecords,
        published,
        inProd: prodLive,
        cities: byCityMap.size,
        publishRate,
      },
      byCity,
      prodSplit: {
        live: prodLive,
        staging: Math.max(0, published - prodLive),
      },
      byState,
    };
  }

  async incrementBotOperation(
    sessionId: string,
    bucket: 'reviews' | 'galleryMenu' | 'imageSync' | 'coverSync',
    success: boolean,
  ): Promise<void> {
    if (!sessionId) return;
    await this.sessionModel.updateOne(
      { _id: new mongoose.Types.ObjectId(sessionId) },
      {
        $set: { [`botOperations.${bucket}.lastRunAt`]: new Date() },
        $inc: {
          [`botOperations.${bucket}.doneCount`]: success ? 1 : 0,
          [`botOperations.${bucket}.failedCount`]: success ? 0 : 1,
        },
      },
    );
  }
}
