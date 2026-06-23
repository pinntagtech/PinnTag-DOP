import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import mongoose from 'mongoose';
import {
  EnvironmentUriKey,
  SeedingErrorMessages,
} from '../../../common/constants';
import { uploadBufferToB2 } from '../../../common/utils/b2-upload.util';
import { SeedingRecordService } from '../seeding-record.service';

// Loose schema so we can read/write arbitrary business fields without
// pinning the typed Business model — the migration / resolve paths in
// this module use the same pattern.
const LOOSE_SCHEMA = new mongoose.Schema<any>(
  {},
  { strict: false, timestamps: true },
);

export interface CoverB2SyncResult {
  synced: number;
  skipped: number;
  failed: number;
  total: number;
  details?: Array<{
    businessId: string;
    outcome: 'synced' | 'skipped' | 'failed';
    reason?: string;
  }>;
}

export interface CoverB2SyncOneOutcome {
  outcome: 'synced' | 'skipped' | 'failed';
  reason?: string;
}

@Injectable()
export class CoverB2SyncService {
  private readonly logger = new Logger(CoverB2SyncService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly recordService: SeedingRecordService,
  ) {}

  // Count businesses awaiting B2 cover sync. Used by the portal to
  // render "Sync pending covers (N)" without paying for a list.
  async countPending(environment: string): Promise<{
    environment: string;
    count: number;
  }> {
    const conn = await this.openTargetConn(environment);
    try {
      const Business = this.businessModel(conn);
      const count = await Business.countDocuments(this.pendingQuery());
      return { environment, count };
    } finally {
      await conn.close();
    }
  }

  // Batch sync: download each business's pendingCoverUrl, upload to
  // B2, write the final cover, clear the pending field. Per-business
  // try/catch so one bad URL never kills the rest of the batch.
  async runBatch(args: {
    environment: string;
    limit?: number;
    dryRun?: boolean;
  }): Promise<CoverB2SyncResult> {
    const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
    const dryRun = args.dryRun === true;

    const conn = await this.openTargetConn(args.environment);
    const result: CoverB2SyncResult = {
      synced: 0,
      skipped: 0,
      failed: 0,
      total: 0,
      details: [],
    };

    try {
      const Business = this.businessModel(conn);

      const docs = (await Business.find(this.pendingQuery())
        .select('_id name placeId cover pendingCoverUrl')
        .sort({ updatedAt: -1 })
        .limit(limit)
        .lean()) as any[];

      result.total = docs.length;

      if (dryRun) {
        // Just report what WOULD be processed; never download/upload.
        for (const d of docs) {
          result.details!.push({
            businessId: String(d._id),
            outcome: 'skipped',
            reason: 'dry_run',
          });
        }
        result.skipped = docs.length;
        this.logger.log(
          `[COVER-B2-SYNC] dry-run env=${args.environment} ` +
            `count=${docs.length}`,
        );
        return result;
      }

      for (const d of docs) {
        const businessId = String(d._id);
        const outcome = await this.syncOneOnConn(Business, d).catch(
          (err: any) => ({
            outcome: 'failed' as const,
            reason: err?.message ?? 'unknown',
          }),
        );
        if (outcome.outcome === 'synced') result.synced += 1;
        else if (outcome.outcome === 'failed') result.failed += 1;
        else result.skipped += 1;
        result.details!.push({ businessId, ...outcome });
      }

      this.logger.log(
        `[COVER-B2-SYNC] env=${args.environment} ` +
          `synced=${result.synced} ` +
          `skipped=${result.skipped} ` +
          `failed=${result.failed} ` +
          `of total=${result.total}`,
      );

      return result;
    } finally {
      await conn.close();
    }
  }

  // Single-business entry point. Called inline from the resolve webhook
  // immediately after pendingCoverUrl is staged so a one-click "Fix"
  // path lands the final B2 cover in the same request. Reuses the
  // exact same per-business logic the batch path uses — no second
  // implementation to drift from.
  async syncOneBusiness(
    environment: string,
    businessId: string,
  ): Promise<CoverB2SyncOneOutcome> {
    const conn = await this.openTargetConn(environment);
    try {
      const Business = this.businessModel(conn);
      const d = (await Business.findById(
        new mongoose.Types.ObjectId(businessId),
      )
        .select('_id name pendingCoverUrl cover')
        .lean()) as any;
      if (!d) return { outcome: 'skipped', reason: 'business_not_found' };
      return await this.syncOneOnConn(Business, d);
    } finally {
      await conn.close();
    }
  }

  // ── Internals ───────────────────────────────────────────────

  // Single-business sync, given an open Business model + a lean doc
  // with _id and pendingCoverUrl. Reused by runBatch + syncOneBusiness.
  private async syncOneOnConn(
    Business: mongoose.Model<any>,
    d: any,
  ): Promise<CoverB2SyncOneOutcome> {
    const businessId = String(d._id);
    const pendingUrl: string | undefined = d.pendingCoverUrl;

    // Re-check cover at write time — between queuing and now another
    // path (operator upload, bot cover_sync) may have landed a real
    // cover. If so, just clear pending and skip.
    const fresh = (await Business.findOne(
      { _id: d._id },
      { cover: 1, pendingCoverUrl: 1 },
    ).lean()) as any;
    const freshCover = fresh?.cover;
    if (typeof freshCover === 'string' && freshCover.length > 0) {
      await Business.updateOne(
        { _id: d._id },
        { $unset: { pendingCoverUrl: '' } },
      );
      return { outcome: 'skipped', reason: 'cover_already_set' };
    }

    if (
      !pendingUrl ||
      typeof pendingUrl !== 'string' ||
      !pendingUrl.startsWith('http')
    ) {
      await Business.updateOne(
        { _id: d._id },
        { $unset: { pendingCoverUrl: '' } },
      );
      return { outcome: 'skipped', reason: 'invalid_pending_url' };
    }

    // Download from Google. Headers match BotWebhookService's existing
    // cover sync path so behaviour is consistent.
    const response = await axios.get(pendingUrl, {
      responseType: 'arraybuffer',
      timeout: 15000,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
          'AppleWebKit/537.36',
        Referer: 'https://www.google.com/',
      },
    });
    const buffer = Buffer.from(response.data as ArrayBuffer);
    const ct =
      (response.headers['content-type'] as string) || 'image/jpeg';

    if (buffer.length <= 5000 || !ct.startsWith('image/')) {
      // Same too-small / wrong-MIME guards as BotWebhookService.
      // Clear pending — Google served us a placeholder; keep the
      // operator's stored cover (currently empty) unchanged.
      await Business.updateOne(
        { _id: d._id },
        { $unset: { pendingCoverUrl: '' } },
      );
      return { outcome: 'skipped', reason: 'bad_image_response' };
    }

    const uploaded = await uploadBufferToB2(
      buffer,
      `cover-${businessId}-${Date.now()}.jpg`,
      ct,
      this.configService,
    );

    await Business.updateOne(
      { _id: d._id },
      {
        $set: {
          cover: uploaded.url,
          coverUploaded: true,
          coverStatus: {
            fetched: true,
            source: 'google_resolve',
            fetchedAt: new Date(),
          },
        },
        $unset: { pendingCoverUrl: '' },
      },
    );

    // Mirror onto the DOP seedingrecord so the operator UI reflects the
    // new cover, same pattern as BotWebhookService. Failure here is
    // logged but doesn't fail the cover-sync outcome — the cover was
    // already written authoritatively above.
    try {
      const dopRecord =
        (await this.recordService
          .findOneByPublishedId(businessId)
          .catch(() => null)) ||
        (await this.recordService
          .findOneByCvbBusinessId(businessId)
          .catch(() => null));
      if (dopRecord) {
        await this.recordService.updateRecord(
          (dopRecord as any)._id.toString(),
          {
            'transformedData.cover': uploaded.url,
            'transformedData.coverThumbnail': uploaded.url,
            'transformedData.coverUploaded': true,
          },
        );
      }
    } catch (mirrorErr: any) {
      this.logger.warn(
        `[COVER-B2-SYNC] mirror failed for ${businessId}: ` +
          `${mirrorErr?.message}`,
      );
    }

    return { outcome: 'synced' };
  }

  // Eligibility for sync: pendingCoverUrl set AND cover effectively
  // unset (missing, null, or empty string). The cover write rule from
  // the brief is strict: ANY non-empty cover value blocks the sync.
  private pendingQuery(): Record<string, any> {
    return {
      pendingCoverUrl: { $exists: true, $nin: [null, ''] },
      $or: [
        { cover: { $exists: false } },
        { cover: null },
        { cover: '' },
      ],
      isDeleted: { $ne: true },
    };
  }

  private async openTargetConn(
    environment: string,
  ): Promise<mongoose.Connection> {
    const uriKey =
      EnvironmentUriKey[environment as keyof typeof EnvironmentUriKey];
    const uri = uriKey
      ? this.configService.get<string>(uriKey)
      : undefined;
    if (!uri) {
      throw new Error(SeedingErrorMessages.missingTargetUri(environment));
    }
    return mongoose.createConnection(uri).asPromise();
  }

  private businessModel(conn: mongoose.Connection): mongoose.Model<any> {
    return (
      conn.models['CoverB2SyncBusiness'] ||
      conn.model('CoverB2SyncBusiness', LOOSE_SCHEMA, 'businesses')
    );
  }
}
