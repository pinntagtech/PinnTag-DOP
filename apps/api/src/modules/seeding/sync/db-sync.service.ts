import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import mongoose, { Model } from 'mongoose';
import {
  EnvironmentUriKey,
  SeedingModules,
  SeedingRecordStatus,
} from '../../../common/constants';
import { OutletCategoryList } from '../../../common/enums';
import {
  SeedingSession,
  SeedingSessionDocument,
} from '../schemas/seeding-session.schema';
import {
  SeedingRecord,
  SeedingRecordDocument,
} from '../schemas/seeding-record.schema';
import {
  DopSyncRun,
  DopSyncRunDocument,
  DopSyncState,
  DopSyncStateDocument,
} from '../schemas/dop-sync-run.schema';
import { DopLinkService } from '../activation/dop-link.service';
import { buildSeededFilter } from '../common/seeded-cohort';
import {
  BUSINESS_FILTER_ARRAY_KEYS,
  OUTLET_FILTER_ARRAY_KEYS,
  buildSeededCreditWallet,
  DOP_SYNC_PROTECTED_FIELDS,
  DOP_SYNC_VERSION,
  generateUniqueId,
  SEED_BUSINESS_STATUS_COVER_ADDED,
  SEED_CONNECT_STATUS,
  SEED_CREATOR_TYPE_ADMIN,
  SEED_DEFAULT_COVER,
  SEED_DEFAULT_LOGO,
  SEED_PROFILE_COMPLETION_LOGO,
  SEED_PROFILE_COMPLETION_PERCENTAGE,
  SEED_TEMPLATE_STATUS,
  SEED_VERIFICATION_STATUS,
} from '../activation/seed-defaults';

const LOOSE_SCHEMA = new mongoose.Schema<any>(
  {},
  { strict: false, timestamps: true },
);

type BusinessFieldPatch = Record<string, any>;

export interface BusinessDiff {
  businessId: string;
  sessionId?: string;
  recordId?: string;
  outcome: 'patched' | 'skipped' | 'failed' | 'assertion_failed' | 'missing';
  changedFields: string[];
  businessSet?: BusinessFieldPatch;
  outletPatches?: Array<{
    outletId: string;
    set: BusinessFieldPatch;
    changedFields: string[];
  }>;
  arrayRepair?: {
    outlets?: string[];
    activatedOutlets?: string[];
    activatedOutletsLength?: number;
    activeOutletsLength?: number;
    physicalUnitsCreated?: number;
    mobileUnitsCreated?: number;
  };
  walletMissing?: boolean;
  linkMissing?: boolean;
  error?: string;
}

export interface PreviewReport {
  runId: string;
  environment: string;
  totals: {
    targeted: number;
    eligible: number;
    excluded: number;
    excludedByReason: Record<string, number>;
    toPatch: number;
    alreadySynced: number;
    assertionFailed: number;
    missingInTarget: number;
    coverageGap: number;
  };
  diffs: BusinessDiff[];
}

export interface ApplyReport {
  runId: string;
  environment: string;
  totals: PreviewReport['totals'] & { patched: number; failed: number };
  results: Array<{
    businessId: string;
    outcome: BusinessDiff['outcome'];
    changedFields: string[];
    error?: string;
  }>;
}

const BATCH_SIZE = 50;

@Injectable()
export class DbSyncService {
  private readonly logger = new Logger(DbSyncService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly dopLinkService: DopLinkService,
    @InjectModel(SeedingSession.name)
    private readonly sessionModel: Model<SeedingSessionDocument>,
    @InjectModel(SeedingRecord.name)
    private readonly recordModel: Model<SeedingRecordDocument>,
    @InjectModel(DopSyncRun.name)
    private readonly runModel: Model<DopSyncRunDocument>,
    @InjectModel(DopSyncState.name)
    private readonly stateModel: Model<DopSyncStateDocument>,
  ) {}

  // ── targetConn helpers (mirror reset/migrate exactly) ─────────────────
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

  // ── Taxonomy remap (source-id → target-id by name) ────────────────────
  // Business docs in pre-prod / prod may hold industry/category ObjectIds
  // that only exist in the source (staging) taxonomy. At sync time we
  // read the name behind each source id and find-or-create the same name
  // in the target's taxonomy collections, then rewrite the business ids
  // to the target's own. Mirrors PostPublishService's semantics.

  private escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private getTaxonomyModels(conn: mongoose.Connection): {
    IndustryModel: mongoose.Model<any>;
    CategoryModel: mongoose.Model<any>;
  } {
    const IndustryModel: mongoose.Model<any> =
      conn.models['BusinessIndustry'] ||
      conn.model(
        'BusinessIndustry',
        new mongoose.Schema(
          { name: String, title: String },
          { collection: 'businessindustries', strict: false },
        ),
      );
    const CategoryModel: mongoose.Model<any> =
      conn.models['BusinessCategory'] ||
      conn.model(
        'BusinessCategory',
        new mongoose.Schema(
          {
            name: String,
            title: String,
            industry: { type: mongoose.Schema.Types.ObjectId },
          },
          { collection: 'businesscategories', strict: false },
        ),
      );
    return { IndustryModel, CategoryModel };
  }

  private async resolveTaxonomyForTarget(
    live: Record<string, any>,
    sourceConn: mongoose.Connection,
    targetConn: mongoose.Connection,
    opts: { dryRun?: boolean } = {},
  ): Promise<{
    businessIndustry?: mongoose.Types.ObjectId;
    businessCategories?: mongoose.Types.ObjectId[];
    pendingIndustryCreate?: string;
    pendingCategoryCreates?: string[];
  } | null> {
    const dryRun = !!opts.dryRun;
    const src = this.getTaxonomyModels(sourceConn);
    const tgt = this.getTaxonomyModels(targetConn);

    const result: {
      businessIndustry?: mongoose.Types.ObjectId;
      businessCategories?: mongoose.Types.ObjectId[];
      pendingIndustryCreate?: string;
      pendingCategoryCreates?: string[];
    } = {};

    // ── Industry ─────────────────────────────────────────────
    let resolvedIndustryId: mongoose.Types.ObjectId | undefined;
    const srcIndustryId = live.businessIndustry;
    if (srcIndustryId) {
      const srcDoc = (await src.IndustryModel.findById(
        srcIndustryId,
      ).lean()) as any;
      if (!srcDoc) {
        this.logger.warn(
          `[SYNC-TAX] Source industry ${String(srcIndustryId)} not found for ` +
            `business ${String(live._id)} — leaving field untouched`,
        );
      } else {
        const name = String(srcDoc.name ?? srcDoc.title ?? '').trim();
        if (!name) {
          this.logger.warn(
            `[SYNC-TAX] Source industry ${String(srcIndustryId)} has empty ` +
              `name — leaving field untouched`,
          );
        } else {
          const pattern = new RegExp(`^${this.escapeRegex(name)}$`, 'i');
          const tgtDoc = (await tgt.IndustryModel.findOne({
            $or: [{ name: pattern }, { title: pattern }],
          }).lean()) as any;
          if (tgtDoc) {
            resolvedIndustryId = tgtDoc._id;
          } else if (dryRun) {
            result.pendingIndustryCreate = name;
          } else {
            const created = await tgt.IndustryModel.create({
              name,
              title: name,
            });
            resolvedIndustryId = created._id;
            this.logger.warn(`[SYNC-TAX] Created target industry: ${name}`);
          }
          if (
            resolvedIndustryId &&
            String(resolvedIndustryId) !== String(srcIndustryId)
          ) {
            result.businessIndustry = resolvedIndustryId;
          }
        }
      }
    }

    // ── Categories ───────────────────────────────────────────
    if (
      Array.isArray(live.businessCategories) &&
      live.businessCategories.length
    ) {
      const resolvedIds: mongoose.Types.ObjectId[] = [];
      const seen = new Set<string>();
      const pendingCreates: string[] = [];
      let anyChanged = false;
      let anyUnresolved = false;

      for (const srcId of live.businessCategories) {
        const srcDoc = (await src.CategoryModel.findById(srcId).lean()) as any;
        if (!srcDoc) {
          this.logger.warn(
            `[SYNC-TAX] Source category ${String(srcId)} not found for ` +
              `business ${String(live._id)} — preserving original id`,
          );
          const key = String(srcId);
          if (!seen.has(key)) {
            seen.add(key);
            resolvedIds.push(srcId);
          }
          continue;
        }
        const name = String(srcDoc.name ?? srcDoc.title ?? '').trim();
        if (!name) {
          this.logger.warn(
            `[SYNC-TAX] Source category ${String(srcId)} has empty name — ` +
              `preserving original id`,
          );
          const key = String(srcId);
          if (!seen.has(key)) {
            seen.add(key);
            resolvedIds.push(srcId);
          }
          continue;
        }

        const pattern = new RegExp(`^${this.escapeRegex(name)}$`, 'i');
        const tgtDoc = (await tgt.CategoryModel.findOne({
          $or: [{ name: pattern }, { title: pattern }],
        }).lean()) as any;

        let targetCatId: mongoose.Types.ObjectId | undefined;
        if (tgtDoc) {
          targetCatId = tgtDoc._id;
        } else if (dryRun) {
          pendingCreates.push(name);
          anyUnresolved = true;
          const key = String(srcId);
          if (!seen.has(key)) {
            seen.add(key);
            resolvedIds.push(srcId);
          }
          continue;
        } else {
          const createPayload: Record<string, any> = { name, title: name };
          if (resolvedIndustryId) {
            createPayload.industry = resolvedIndustryId;
          }
          const created = await tgt.CategoryModel.create(createPayload);
          targetCatId = created._id;
          this.logger.warn(`[SYNC-TAX] Created target category: ${name}`);
        }

        if (String(targetCatId) !== String(srcId)) anyChanged = true;
        const key = String(targetCatId);
        if (!seen.has(key)) {
          seen.add(key);
          resolvedIds.push(targetCatId as mongoose.Types.ObjectId);
        }
      }

      // Only rewrite the array when all entries resolved cleanly. In dryRun
      // with pending creates we can't produce a valid target array yet —
      // report the pending creates and leave the field for apply.
      if (!anyUnresolved && anyChanged) {
        result.businessCategories = resolvedIds;
      }
      if (pendingCreates.length) {
        result.pendingCategoryCreates = pendingCreates;
      }
    }

    if (
      !result.businessIndustry &&
      !result.businessCategories &&
      !result.pendingIndustryCreate &&
      !(result.pendingCategoryCreates && result.pendingCategoryCreates.length)
    ) {
      return null;
    }
    return result;
  }

  // ── Prod-eligibility gate (read-only, batched) ────────────────────────
  // Applied AFTER resolveScope + AFTER target conn open, BEFORE the
  // per-business patch loop. Restricts sync to businesses that pass ALL
  // of the criteria below; excluded ones report their first-failure
  // reason so operators can see why the raw scope shrunk.
  //
  // Criteria (in evaluation order — first failure wins):
  //   active_outlet     — isActive & activatedOutletsLength ≥ 1
  //   real_cover        — cover matches media-staging.pinntag.com
  //                       (not empty, not googleusercontent, not the
  //                       SEED_DEFAULT_COVER placeholder)
  //   real_hours        — resolveStatus.hours === 'done' AND hoursRaw
  //                       array non-empty
  //   taxonomy_present  — businessIndustry set AND businessCategories
  //                       non-empty (the resolver remaps the ids at
  //                       patch time — this only checks presence)
  //   valid_address     — addressLine1 non-empty, not a URL/phone; city
  //                       non-empty, not "*county*"
  //   singleton_placeId — placeId present AND appears exactly once
  //                       across the scope's target docs (dupes get
  //                       ALL copies excluded)
  //   domestic_coords   — coords finite, not (0,0); country == US (if
  //                       set) AND within US bbox

  private static readonly US_LAT_MIN = 24;
  private static readonly US_LAT_MAX = 50;
  private static readonly US_LNG_MIN = -125;
  private static readonly US_LNG_MAX = -66;
  private static readonly URL_RE = /^\s*(https?:\/\/|www\.)/i;
  private static readonly PHONE_RE = /^\+?[\d\s\-().]{7,}$/;
  private static readonly COUNTY_RE = /county/i;
  private static readonly GOOGLE_HOST_RE = /googleusercontent/i;
  private static readonly MEDIA_STAGING_RE = /media-staging\.pinntag\.com/i;

  private isFiniteNumber(v: any): v is number {
    return typeof v === 'number' && Number.isFinite(v);
  }

  private extractCoords(
    doc: Record<string, any>,
  ): { lat: number; lng: number } | null {
    // Try common shapes: {latitude, longitude}, {lat, lng}, or
    // location.coordinates = [lng, lat] (GeoJSON).
    const lat =
      this.isFiniteNumber(doc.latitude)
        ? doc.latitude
        : this.isFiniteNumber(doc.lat)
          ? doc.lat
          : this.isFiniteNumber(doc?.location?.coordinates?.[1])
            ? doc.location.coordinates[1]
            : null;
    const lng =
      this.isFiniteNumber(doc.longitude)
        ? doc.longitude
        : this.isFiniteNumber(doc.lng)
          ? doc.lng
          : this.isFiniteNumber(doc?.location?.coordinates?.[0])
            ? doc.location.coordinates[0]
            : null;
    if (lat === null || lng === null) return null;
    return { lat, lng };
  }

  private evaluateEligibility(
    doc: Record<string, any> | undefined,
    placeIdCounts: Map<string, number>,
  ): { ok: true } | { ok: false; reason: string } {
    if (!doc) return { ok: false, reason: 'missing_target_doc' };

    // 1. active_outlet
    if (
      !(doc.isActive === true) ||
      !(
        typeof doc.activatedOutletsLength === 'number' &&
        doc.activatedOutletsLength >= 1
      )
    ) {
      return { ok: false, reason: 'active_outlet' };
    }

    // 2. real_cover
    const cover = typeof doc.cover === 'string' ? doc.cover : '';
    if (
      !cover ||
      cover === SEED_DEFAULT_COVER ||
      DbSyncService.GOOGLE_HOST_RE.test(cover) ||
      !DbSyncService.MEDIA_STAGING_RE.test(cover)
    ) {
      return { ok: false, reason: 'real_cover' };
    }

    // 3. real_hours
    const rs = doc.resolveStatus;
    if (
      !rs ||
      rs.hours !== 'done' ||
      !Array.isArray(rs.hoursRaw) ||
      rs.hoursRaw.length === 0
    ) {
      return { ok: false, reason: 'real_hours' };
    }

    // 4. taxonomy_present
    if (
      !doc.businessIndustry ||
      !Array.isArray(doc.businessCategories) ||
      doc.businessCategories.length === 0
    ) {
      return { ok: false, reason: 'taxonomy_present' };
    }

    // 5. valid_address
    const rawAddr =
      typeof doc.addressLine1 === 'string' ? doc.addressLine1.trim() : '';
    if (
      !rawAddr ||
      DbSyncService.URL_RE.test(rawAddr) ||
      DbSyncService.PHONE_RE.test(rawAddr)
    ) {
      return { ok: false, reason: 'valid_address' };
    }
    const city = typeof doc.city === 'string' ? doc.city.trim() : '';
    if (!city || DbSyncService.COUNTY_RE.test(city)) {
      return { ok: false, reason: 'valid_address' };
    }

    // 6. singleton_placeId
    const placeId = typeof doc.placeId === 'string' ? doc.placeId.trim() : '';
    if (!placeId) return { ok: false, reason: 'singleton_placeId' };
    if ((placeIdCounts.get(placeId) ?? 0) > 1) {
      return { ok: false, reason: 'singleton_placeId' };
    }

    // 7. domestic_coords
    const coords = this.extractCoords(doc);
    if (!coords) return { ok: false, reason: 'domestic_coords' };
    if (coords.lat === 0 && coords.lng === 0) {
      return { ok: false, reason: 'domestic_coords' };
    }
    const country =
      typeof doc.country === 'string' ? doc.country.trim() : '';
    if (country && country.toLowerCase() !== 'united states') {
      return { ok: false, reason: 'domestic_coords' };
    }
    if (
      coords.lat < DbSyncService.US_LAT_MIN ||
      coords.lat > DbSyncService.US_LAT_MAX ||
      coords.lng < DbSyncService.US_LNG_MIN ||
      coords.lng > DbSyncService.US_LNG_MAX
    ) {
      return { ok: false, reason: 'domestic_coords' };
    }

    return { ok: true };
  }

  private async filterEligible(
    scope: Array<{ publishedId: string; sessionId: string; recordId: string }>,
    BusinessModel: Model<any>,
  ): Promise<{
    eligible: typeof scope;
    excluded: { total: number; byReason: Record<string, number> };
  }> {
    const byReason: Record<string, number> = {};
    const bump = (r: string) => {
      byReason[r] = (byReason[r] ?? 0) + 1;
    };

    if (!scope.length) {
      return { eligible: [], excluded: { total: 0, byReason } };
    }

    const objectIds = scope
      .map((s) => s.publishedId)
      .filter((id) => mongoose.isValidObjectId(id))
      .map((id) => new mongoose.Types.ObjectId(id));

    // Single batched load — only the fields the gate reads.
    const docs = (await BusinessModel.find(
      { _id: { $in: objectIds } },
      {
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
        country: 1,
        latitude: 1,
        longitude: 1,
        lat: 1,
        lng: 1,
        location: 1,
      },
    ).lean()) as any[];

    const byId = new Map<string, Record<string, any>>();
    for (const d of docs) byId.set(String(d._id), d);

    // placeId → count map over the scope's target docs (dupes get ALL
    // copies excluded).
    const placeIdCounts = new Map<string, number>();
    for (const d of docs) {
      const p = typeof d.placeId === 'string' ? d.placeId.trim() : '';
      if (!p) continue;
      placeIdCounts.set(p, (placeIdCounts.get(p) ?? 0) + 1);
    }

    const eligible: typeof scope = [];
    for (const item of scope) {
      const doc = byId.get(item.publishedId);
      const verdict = this.evaluateEligibility(doc, placeIdCounts);
      if (verdict.ok) {
        eligible.push(item);
      } else {
        bump(verdict.reason);
      }
    }

    return {
      eligible,
      excluded: { total: scope.length - eligible.length, byReason },
    };
  }

  // ── STEP 2 — scope resolver ───────────────────────────────────────────
  async resolveScope(
    environment: string,
  ): Promise<Array<{ publishedId: string; sessionId: string; recordId: string }>> {
    const sessions = await this.sessionModel
      .find({ environment })
      .select('_id')
      .lean();

    if (sessions.length === 0) return [];

    const sessionIds = sessions.map((s) => (s as any)._id);
    const records = await this.recordModel
      .find({
        sessionId: { $in: sessionIds },
        module: SeedingModules.BUSINESS,
        status: SeedingRecordStatus.PUBLISHED,
        publishedId: { $exists: true, $ne: null },
      })
      .select('publishedId sessionId')
      .lean();

    // De-duplicate by publishedId; keep the first sessionId/recordId we
    // see — collisions only happen if a business was published from
    // multiple sessions, which is unusual but harmless.
    const seen = new Set<string>();
    const out: Array<{
      publishedId: string;
      sessionId: string;
      recordId: string;
    }> = [];
    for (const r of records) {
      const pid = String((r as any).publishedId);
      if (!pid || seen.has(pid)) continue;
      seen.add(pid);
      out.push({
        publishedId: pid,
        sessionId: String((r as any).sessionId),
        recordId: String((r as any)._id),
      });
    }
    return out;
  }

  async coverageCheck(
    environment: string,
    scopeIds: string[],
  ): Promise<number> {
    const targetUri = this.resolveTargetUri(environment);
    const conn = await mongoose.createConnection(targetUri).asPromise();
    try {
      const BusinessModel =
        conn.models['Business'] ||
        conn.model('Business', LOOSE_SCHEMA, 'businesses');
      const targetCount = await BusinessModel.countDocuments(
        buildSeededFilter(),
      );
      return Math.max(0, targetCount - scopeIds.length);
    } finally {
      await conn.close();
    }
  }

  // ── Diff helpers ──────────────────────────────────────────────────────
  private isEmpty(v: any): boolean {
    if (v === undefined || v === null) return true;
    if (typeof v === 'string' && v.trim() === '') return true;
    if (Array.isArray(v) && v.length === 0) return true;
    return false;
  }

  private isProtected(field: string): boolean {
    return (DOP_SYNC_PROTECTED_FIELDS as readonly string[]).includes(field);
  }

  // For non-array seed fields: include in $set iff the live value is empty.
  private maybeSetMissing(
    diff: BusinessFieldPatch,
    field: string,
    live: any,
    seedValue: any,
  ): void {
    if (this.isProtected(field)) return;
    if (this.isEmpty(live) && !this.isEmpty(seedValue)) {
      diff[field] = seedValue;
    }
  }

  // For the filter arrays: include iff the live value isn't a (non-empty
  // or empty) array. Wrong-type / undefined → repair to []. Existing empty
  // array is fine, leave it. Existing populated array — never overwrite.
  private maybeSetArrayMissing(
    diff: BusinessFieldPatch,
    field: string,
    live: any,
  ): void {
    if (!Array.isArray(live)) {
      diff[field] = [];
    }
  }

  private computeBusinessSet(
    live: Record<string, any>,
    systemUserId: mongoose.Types.ObjectId,
  ): BusinessFieldPatch {
    const set: BusinessFieldPatch = {};

    // identity / ownership
    this.maybeSetMissing(set, 'creatorType', live.creatorType, SEED_CREATOR_TYPE_ADMIN);
    this.maybeSetMissing(set, 'creator', live.creator, systemUserId);
    this.maybeSetMissing(set, 'authorisedUser', live.authorisedUser, systemUserId);
    this.maybeSetMissing(set, 'isClaimed', live.isClaimed, false);

    // lifecycle / provenance
    this.maybeSetMissing(set, 'status', live.status, SEED_BUSINESS_STATUS_COVER_ADDED);
    this.maybeSetMissing(set, 'isFromCrawler', live.isFromCrawler, true);
    this.maybeSetMissing(set, 'dataFetchedFromGoogle', live.dataFetchedFromGoogle, true);
    this.maybeSetMissing(set, 'isActive', live.isActive, true);
    this.maybeSetMissing(set, 'isDeleted', live.isDeleted, false);
    this.maybeSetMissing(set, 'verificationStatus', live.verificationStatus, SEED_VERIFICATION_STATUS);
    this.maybeSetMissing(set, 'showVerificationBanner', live.showVerificationBanner, true);

    // media defaults — protected; only fill if absent
    this.maybeSetMissing(set, 'logo', live.logo, SEED_DEFAULT_LOGO);
    this.maybeSetMissing(set, 'logoThumbnail', live.logoThumbnail, SEED_DEFAULT_LOGO);
    this.maybeSetMissing(set, 'cover', live.cover, SEED_DEFAULT_COVER);
    this.maybeSetMissing(set, 'coverThumbnail', live.coverThumbnail, SEED_DEFAULT_COVER);
    this.maybeSetMissing(set, 'logoUploaded', live.logoUploaded, false);

    // profile completion baseline
    this.maybeSetMissing(set, 'profileCompletionStatus', live.profileCompletionStatus, SEED_PROFILE_COMPLETION_LOGO);
    this.maybeSetMissing(set, 'profileCompletionPercentage', live.profileCompletionPercentage, SEED_PROFILE_COMPLETION_PERCENTAGE);
    this.maybeSetMissing(set, 'completedQuestionnaireSteps', live.completedQuestionnaireSteps, 0);
    this.maybeSetMissing(set, 'totalQuestionnaireSteps', live.totalQuestionnaireSteps, 0);
    this.maybeSetMissing(set, 'aiTrainingPercentage', live.aiTrainingPercentage, 0);

    // counters
    this.maybeSetMissing(set, 'followersCount', live.followersCount, 0);
    this.maybeSetMissing(set, 'followingCount', live.followingCount, 0);
    this.maybeSetMissing(set, 'viewsCount', live.viewsCount, 0);

    // onboarding / journey
    this.maybeSetMissing(set, 'continueJourney', live.continueJourney, true);
    this.maybeSetMissing(set, 'onboardingOfferStatus', live.onboardingOfferStatus, 0);
    this.maybeSetMissing(set, 'isOnboardingOfferDone', live.isOnboardingOfferDone, false);
    this.maybeSetMissing(set, 'scalabilityFactor', live.scalabilityFactor, 0);

    // unit type flags
    this.maybeSetMissing(set, 'isPhysicalType', live.isPhysicalType, false);
    this.maybeSetMissing(set, 'physicalUnits', live.physicalUnits, 0);
    this.maybeSetMissing(set, 'isMobileType', live.isMobileType, false);
    this.maybeSetMissing(set, 'mobileUnits', live.mobileUnits, 0);
    this.maybeSetMissing(set, 'isOnlineType', live.isOnlineType, false);

    // integrations
    this.maybeSetMissing(set, 'connectStatus', live.connectStatus, SEED_CONNECT_STATUS);
    this.maybeSetMissing(set, 'stripeOnboardingComplete', live.stripeOnboardingComplete, false);
    this.maybeSetMissing(set, 'templateGenerationStatus', live.templateGenerationStatus, SEED_TEMPLATE_STATUS);
    this.maybeSetMissing(set, 'isAgentCreated', live.isAgentCreated, false);
    this.maybeSetMissing(set, 'isFacebookConnected', live.isFacebookConnected, false);
    this.maybeSetMissing(set, 'isInstagramConnected', live.isInstagramConnected, false);
    this.maybeSetMissing(set, 'isXConnected', live.isXConnected, false);
    this.maybeSetMissing(set, 'isFacebookDatafetched', live.isFacebookDatafetched, false);
    this.maybeSetMissing(set, 'isBoosted', live.isBoosted, false);
    this.maybeSetMissing(set, 'boostOrder', live.boostOrder, 1000);

    // verification flags
    this.maybeSetMissing(set, 'isEmailVerified', live.isEmailVerified, false);
    this.maybeSetMissing(set, 'isPhoneVerified', live.isPhoneVerified, false);

    // filter arrays — repair only if absent / wrong-type
    for (const key of BUSINESS_FILTER_ARRAY_KEYS) {
      this.maybeSetArrayMissing(set, key, live[key]);
    }

    // uniqueId — protected; only fill if absent
    if (this.isEmpty(live.uniqueId)) {
      set.uniqueId = generateUniqueId(live.name);
    }

    return set;
  }

  private computeOutletSet(live: Record<string, any>): {
    set: BusinessFieldPatch;
    changedFields: string[];
  } {
    const set: BusinessFieldPatch = {};

    if (live.isActive !== true) set.isActive = true;
    if (this.isEmpty(live.servingRadius)) set.servingRadius = 60;
    if (!Array.isArray(live.spots)) set.spots = [];

    // postalCode <- zip (set-if-missing; never overwrite a populated value)
    if (this.isEmpty(live.postalCode) && !this.isEmpty(live.zip)) {
      set.postalCode = live.zip;
    }

    // GeoJSON repair: build if absent OR malformed (missing coordinates
    // or coordinates not [lng, lat] number pair).
    const loc = live.location;
    const validLoc =
      loc &&
      loc.type === 'Point' &&
      Array.isArray(loc.coordinates) &&
      loc.coordinates.length === 2 &&
      Number.isFinite(loc.coordinates[0]) &&
      Number.isFinite(loc.coordinates[1]);
    if (!validLoc) {
      const lng = Number(live.longitude);
      const lat = Number(live.latitude);
      if (Number.isFinite(lng) && Number.isFinite(lat) && (lng !== 0 || lat !== 0)) {
        set.location = { type: 'Point', coordinates: [lng, lat] };
      }
    }

    for (const key of OUTLET_FILTER_ARRAY_KEYS) {
      this.maybeSetArrayMissing(set, key, live[key]);
    }

    return { set, changedFields: Object.keys(set) };
  }

  // Detect inconsistency between outlets / activatedOutlets / length counters
  // and return the repaired values (or undefined if everything's consistent).
  private computeArrayRepair(
    live: Record<string, any>,
    activeOutletIds: string[],
  ): BusinessDiff['arrayRepair'] | undefined {
    const outletsArr = Array.isArray(live.outlets) ? live.outlets.map(String) : [];
    const activatedArr = Array.isArray(live.activatedOutlets)
      ? live.activatedOutlets.map(String)
      : [];
    const expected = activeOutletIds.map(String);

    const diff: any = {};
    const arrayEqual = (a: string[], b: string[]) =>
      a.length === b.length && a.every((v, i) => v === b[i]);

    if (!arrayEqual(outletsArr, expected)) diff.outlets = expected;
    if (!arrayEqual(activatedArr, expected)) diff.activatedOutlets = expected;
    if (live.activatedOutletsLength !== expected.length)
      diff.activatedOutletsLength = expected.length;
    if (live.activeOutletsLength !== expected.length)
      diff.activeOutletsLength = expected.length;

    return Object.keys(diff).length > 0 ? diff : undefined;
  }

  private resolveSystemUserId(
    pinntagUser: any,
    live: Record<string, any>,
  ): mongoose.Types.ObjectId | null {
    return (
      (pinntagUser as any)?._id ||
      (live as any).authorisedUser ||
      (live as any).creator ||
      null
    );
  }

  // ── STEP 3 — Preview (writes nothing to target) ───────────────────────
  async previewSync(
    environment: string,
    startedBy: string,
  ): Promise<PreviewReport> {
    const scope = await this.resolveScope(environment);
    const scopeIds = scope.map((s) => s.publishedId);

    const runDoc = await this.runModel.create({
      environment,
      status: 'previewing',
      startedBy,
      startedAt: new Date(),
    });

    const targetUri = this.resolveTargetUri(environment);
    const conn = await mongoose.createConnection(targetUri).asPromise();
    // Source (staging) conn — only needed when target ≠ staging, since
    // staging ids are already target-correct for a staging→staging sync.
    const sourceConn: mongoose.Connection | null =
      environment === 'staging'
        ? null
        : await mongoose
            .createConnection(this.resolveTargetUri('staging'))
            .asPromise();
    const diffs: BusinessDiff[] = [];

    try {
      const BusinessModel =
        conn.models['Business'] ||
        conn.model('Business', LOOSE_SCHEMA, 'businesses');
      const OutletModel =
        conn.models['Outlet'] ||
        conn.model('Outlet', LOOSE_SCHEMA, 'outlets');
      const CreditWalletModel =
        conn.models['CreditWallet'] ||
        conn.model('CreditWallet', LOOSE_SCHEMA, 'creditwallets');
      const BusinessUserModel =
        conn.models['BusinessUser'] ||
        conn.model('BusinessUser', LOOSE_SCHEMA, 'businessusers');

      // Prod-eligibility gate — restricts the sync to businesses that
      // pass the 7 quality criteria. Reports first-failure reasons in
      // `excludedByReason` for operator visibility.
      const { eligible: eligibleScope, excluded } = await this.filterEligible(
        scope,
        BusinessModel,
      );
      const eligibleScopeIds = eligibleScope.map((s) => s.publishedId);

      const pinntagEmail = this.configService.get<string>(
        'app.pinntagBusinessUserEmail',
      );
      const pinntagUser = pinntagEmail
        ? await BusinessUserModel.findOne({ email: pinntagEmail })
            .select('_id')
            .lean()
        : null;

      // alreadySynced lookup in one query (over the eligible subset only)
      const stateRows = await this.stateModel
        .find({
          environment,
          syncVersion: DOP_SYNC_VERSION,
          businessId: {
            $in: eligibleScopeIds
              .filter((id) => mongoose.isValidObjectId(id))
              .map((id) => new mongoose.Types.ObjectId(id)),
          },
        })
        .select('businessId')
        .lean();
      const syncedSet = new Set(
        stateRows.map((r: any) => String(r.businessId)),
      );

      let alreadySynced = 0;
      let assertionFailed = 0;
      let missing = 0;
      let toPatch = 0;

      for (const item of eligibleScope) {
        const { publishedId, sessionId, recordId } = item;

        if (syncedSet.has(publishedId)) {
          alreadySynced++;
          diffs.push({
            businessId: publishedId,
            sessionId,
            recordId,
            outcome: 'skipped',
            changedFields: [],
          });
          continue;
        }

        if (!mongoose.isValidObjectId(publishedId)) {
          missing++;
          diffs.push({
            businessId: publishedId,
            sessionId,
            recordId,
            outcome: 'missing',
            changedFields: [],
            error: 'invalid ObjectId',
          });
          continue;
        }

        const live = (await BusinessModel.findById(publishedId).lean()) as any;
        if (!live) {
          missing++;
          diffs.push({
            businessId: publishedId,
            sessionId,
            recordId,
            outcome: 'missing',
            changedFields: [],
          });
          continue;
        }

        // Secondary assertion (NOT selector): isFromCrawler || isCvb
        if (!(live.isFromCrawler === true || live.isCvb === true)) {
          assertionFailed++;
          diffs.push({
            businessId: publishedId,
            sessionId,
            recordId,
            outcome: 'assertion_failed',
            changedFields: [],
            error: 'business is not flagged isFromCrawler or isCvb',
          });
          continue;
        }

        const systemUserId = this.resolveSystemUserId(pinntagUser, live);
        const businessSet = systemUserId
          ? this.computeBusinessSet(live, systemUserId)
          : this.computeBusinessSet(live, live._id);

        // Taxonomy remap (read-only in preview): if any source id needs
        // to be rewritten to the target's own id (found or would-create),
        // merge the target ids into businessSet so they surface in the diff.
        let taxResult: Awaited<
          ReturnType<typeof this.resolveTaxonomyForTarget>
        > = null;
        if (sourceConn) {
          try {
            taxResult = await this.resolveTaxonomyForTarget(
              live,
              sourceConn,
              conn,
              { dryRun: true },
            );
            if (taxResult?.businessIndustry) {
              (businessSet as any).businessIndustry = taxResult.businessIndustry;
            }
            if (taxResult?.businessCategories) {
              (businessSet as any).businessCategories =
                taxResult.businessCategories;
            }
          } catch (err: any) {
            this.logger.warn(
              `[SYNC-TAX] preview resolver failed for ${publishedId}: ${err?.message}`,
            );
          }
        }
        const changedFields = Object.keys(businessSet);
        if (taxResult?.pendingIndustryCreate) {
          changedFields.push('businessIndustry:create');
        }
        if (taxResult?.pendingCategoryCreates?.length) {
          for (const n of taxResult.pendingCategoryCreates) {
            changedFields.push(`category:create:${n}`);
          }
        }

        // Outlets diff
        const outlets = await OutletModel.find({
          business: new mongoose.Types.ObjectId(publishedId),
          isDeleted: { $ne: true },
        }).lean();

        const outletPatches: NonNullable<BusinessDiff['outletPatches']> = [];
        for (const o of outlets as any[]) {
          const { set, changedFields: oCf } = this.computeOutletSet(o);
          if (oCf.length > 0) {
            outletPatches.push({
              outletId: String(o._id),
              set,
              changedFields: oCf,
            });
            changedFields.push(`outlet:${String(o._id)}`);
          }
        }

        // Array lockstep repair (uses all active outlets that should be on
        // the business — the same set we computed above filtered to isActive).
        const activeOutletIds = (outlets as any[])
          .filter((o) => o.isActive !== false)
          .map((o) => String(o._id));
        const arrayRepair = this.computeArrayRepair(live, activeOutletIds);
        if (arrayRepair) {
          for (const k of Object.keys(arrayRepair)) {
            changedFields.push(`array:${k}`);
          }
        }

        // CreditWallet missing?
        const walletDoc = await CreditWalletModel.findOne({
          business: new mongoose.Types.ObjectId(publishedId),
        })
          .select('_id')
          .lean();
        const walletMissing = !walletDoc;
        if (walletMissing) changedFields.push('creditWallet:create');

        const linkMissing = this.isEmpty(live.appRedirectLink);
        if (linkMissing) changedFields.push('appRedirectLink');

        if (changedFields.length === 0) {
          // Nothing to do — mark as synced now so future runs short-circuit.
          diffs.push({
            businessId: publishedId,
            sessionId,
            recordId,
            outcome: 'skipped',
            changedFields: [],
          });
          continue;
        }

        toPatch++;
        diffs.push({
          businessId: publishedId,
          sessionId,
          recordId,
          outcome: 'patched', // tentative; apply step is the authority
          changedFields,
          businessSet,
          outletPatches: outletPatches.length ? outletPatches : undefined,
          arrayRepair,
          walletMissing,
          linkMissing,
        });
      }

      const coverageGap = await this.coverageCheck(
        environment,
        eligibleScopeIds,
      );

      const totals = {
        targeted: scope.length, // raw scope size (all published)
        eligible: eligibleScope.length,
        excluded: excluded.total,
        excludedByReason: excluded.byReason,
        toPatch,
        alreadySynced,
        assertionFailed,
        missingInTarget: missing,
        coverageGap,
      };

      runDoc.status = 'previewed';
      runDoc.finishedAt = new Date();
      runDoc.totals = totals as any;
      runDoc.results = diffs.map((d) => ({
        businessId: d.businessId,
        sessionId: d.sessionId,
        recordId: d.recordId,
        outcome: d.outcome,
        changedFields: d.changedFields,
        error: d.error,
      })) as any;
      await runDoc.save();

      return {
        runId: String(runDoc._id),
        environment,
        totals,
        diffs,
      };
    } finally {
      await conn.close();
      if (sourceConn) await sourceConn.close();
    }
  }

  // ── STEP 4 — Apply (gated, batched, resumable) ────────────────────────
  async applySync(
    environment: string,
    payload: { adminPassword?: string; startedBy: string },
  ): Promise<ApplyReport> {
    if (environment === 'production') {
      const expected = this.configService.get<string>('app.dopAdminPassword');
      if (!expected || payload.adminPassword !== expected) {
        throw new Error('Invalid admin password for production sync');
      }
    }

    const scope = await this.resolveScope(environment);

    const runDoc = await this.runModel.create({
      environment,
      status: 'applying',
      startedBy: payload.startedBy,
      startedAt: new Date(),
    });

    const targetUri = this.resolveTargetUri(environment);
    const conn = await mongoose.createConnection(targetUri).asPromise();
    // Source (staging) conn — see previewSync for the reasoning.
    const sourceConn: mongoose.Connection | null =
      environment === 'staging'
        ? null
        : await mongoose
            .createConnection(this.resolveTargetUri('staging'))
            .asPromise();

    const results: ApplyReport['results'] = [];
    let patchedCount = 0;
    let failedCount = 0;
    let alreadySynced = 0;
    let assertionFailed = 0;
    let missing = 0;

    try {
      // 2dsphere index up-front (idempotent)
      try {
        await conn.collection('outlets').createIndex({ location: '2dsphere' });
      } catch (err: any) {
        this.logger.warn(
          `[SYNC] 2dsphere index ensure skipped: ${err?.message}`,
        );
      }

      const BusinessModel =
        conn.models['Business'] ||
        conn.model('Business', LOOSE_SCHEMA, 'businesses');
      const OutletModel =
        conn.models['Outlet'] ||
        conn.model('Outlet', LOOSE_SCHEMA, 'outlets');
      const CreditWalletModel =
        conn.models['CreditWallet'] ||
        conn.model('CreditWallet', LOOSE_SCHEMA, 'creditwallets');
      const BusinessUserModel =
        conn.models['BusinessUser'] ||
        conn.model('BusinessUser', LOOSE_SCHEMA, 'businessusers');

      // Prod-eligibility gate — same as previewSync, applied before the
      // batched patch loop so we never write anything for excluded ids.
      const { eligible: eligibleScope, excluded } = await this.filterEligible(
        scope,
        BusinessModel,
      );

      const pinntagEmail = this.configService.get<string>(
        'app.pinntagBusinessUserEmail',
      );
      const pinntagUser = pinntagEmail
        ? await BusinessUserModel.findOne({ email: pinntagEmail })
            .select('_id')
            .lean()
        : null;

      for (let i = 0; i < eligibleScope.length; i += BATCH_SIZE) {
        const batch = eligibleScope.slice(i, i + BATCH_SIZE);

        // Re-check synced state per batch so resumed runs see fresh markers.
        const batchIds = batch
          .map((b) => b.publishedId)
          .filter((id) => mongoose.isValidObjectId(id))
          .map((id) => new mongoose.Types.ObjectId(id));
        const stateRows = await this.stateModel
          .find({
            environment,
            syncVersion: DOP_SYNC_VERSION,
            businessId: { $in: batchIds },
          })
          .select('businessId')
          .lean();
        const syncedSet = new Set(
          stateRows.map((r: any) => String(r.businessId)),
        );

        for (const item of batch) {
          const { publishedId, sessionId, recordId } = item;

          if (syncedSet.has(publishedId)) {
            alreadySynced++;
            results.push({
              businessId: publishedId,
              outcome: 'skipped',
              changedFields: [],
            });
            continue;
          }

          try {
            if (!mongoose.isValidObjectId(publishedId)) {
              missing++;
              results.push({
                businessId: publishedId,
                outcome: 'missing',
                changedFields: [],
                error: 'invalid ObjectId',
              });
              continue;
            }

            const live = (await BusinessModel.findById(publishedId).lean()) as any;
            if (!live) {
              missing++;
              results.push({
                businessId: publishedId,
                outcome: 'missing',
                changedFields: [],
              });
              continue;
            }

            if (!(live.isFromCrawler === true || live.isCvb === true)) {
              assertionFailed++;
              results.push({
                businessId: publishedId,
                outcome: 'assertion_failed',
                changedFields: [],
                error: 'business is not flagged isFromCrawler or isCvb',
              });
              continue;
            }

            const systemUserId =
              this.resolveSystemUserId(pinntagUser, live) || live._id;
            const businessSet = this.computeBusinessSet(live, systemUserId);

            // Taxonomy remap (find-or-create on target). Runs before the
            // $set below so remapped businessIndustry/businessCategories
            // land in the same single updateOne call.
            if (sourceConn) {
              try {
                const taxResult = await this.resolveTaxonomyForTarget(
                  live,
                  sourceConn,
                  conn,
                  { dryRun: false },
                );
                if (taxResult?.businessIndustry) {
                  (businessSet as any).businessIndustry =
                    taxResult.businessIndustry;
                }
                if (taxResult?.businessCategories) {
                  (businessSet as any).businessCategories =
                    taxResult.businessCategories;
                }
              } catch (err: any) {
                this.logger.warn(
                  `[SYNC-TAX] apply resolver failed for ${publishedId}: ${err?.message}`,
                );
              }
            }
            const changedFields: string[] = Object.keys(businessSet);

            // Apply business $set if non-empty
            if (Object.keys(businessSet).length > 0) {
              await BusinessModel.updateOne(
                { _id: new mongoose.Types.ObjectId(publishedId) },
                { $set: businessSet },
              );
            }

            // Outlets — re-load and patch individually
            const outlets = (await OutletModel.find({
              business: new mongoose.Types.ObjectId(publishedId),
              isDeleted: { $ne: true },
            }).lean()) as any[];

            for (const o of outlets) {
              const { set: oSet, changedFields: oCf } =
                this.computeOutletSet(o);
              if (oCf.length > 0) {
                await OutletModel.updateOne(
                  { _id: o._id },
                  { $set: oSet },
                );
                changedFields.push(`outlet:${String(o._id)}`);
              }
            }

            // Array lockstep repair
            const activeOutletIds = outlets
              .filter((o) => o.isActive !== false)
              .map((o) => String(o._id));
            const arrayRepair = this.computeArrayRepair(live, activeOutletIds);
            if (arrayRepair) {
              const physicalCount = outlets.filter(
                (o) =>
                  o.isActive !== false &&
                  o.category === OutletCategoryList.PHYSICAL,
              ).length;
              const mobileCount = outlets.filter(
                (o) =>
                  o.isActive !== false &&
                  o.category === OutletCategoryList.MOBILE,
              ).length;
              const set: BusinessFieldPatch = { ...arrayRepair };
              // Counters mirror what activate() increments at publish.
              if (live.physicalUnitsCreated !== physicalCount) {
                set.physicalUnitsCreated = physicalCount;
              }
              if (live.mobileUnitsCreated !== mobileCount) {
                set.mobileUnitsCreated = mobileCount;
              }
              await BusinessModel.updateOne(
                { _id: new mongoose.Types.ObjectId(publishedId) },
                { $set: set },
              );
              for (const k of Object.keys(set)) {
                changedFields.push(`array:${k}`);
              }
            }

            // CreditWallet upsert (idempotent)
            const walletRes = await CreditWalletModel.findOneAndUpdate(
              { business: new mongoose.Types.ObjectId(publishedId) },
              {
                $setOnInsert: buildSeededCreditWallet(
                  new mongoose.Types.ObjectId(publishedId),
                ),
              },
              { upsert: true, new: true, includeResultMetadata: true } as any,
            ).lean();
            if (
              (walletRes as any)?.lastErrorObject?.updatedExisting === false
            ) {
              changedFields.push('creditWallet:create');
            }

            // appRedirectLink — only mint if absent (it is in the
            // protected list for "real" overwrite, but it's the very field
            // we're trying to fill — set-if-missing applies).
            if (this.isEmpty(live.appRedirectLink)) {
              const shareImage =
                live.coverThumbnail ||
                live.cover ||
                SEED_DEFAULT_COVER;
              const appRedirectLink =
                await this.dopLinkService.generateBusinessShareLink(
                  publishedId,
                  live.name,
                  shareImage,
                );
              await BusinessModel.updateOne(
                { _id: new mongoose.Types.ObjectId(publishedId) },
                { $set: { appRedirectLink } },
              );
              changedFields.push('appRedirectLink');
            }

            // Mark synced (upsert keyed on env+businessId)
            await this.stateModel.updateOne(
              {
                environment,
                businessId: new mongoose.Types.ObjectId(publishedId),
              },
              {
                $set: {
                  syncVersion: DOP_SYNC_VERSION,
                  syncedAt: new Date(),
                },
              },
              { upsert: true },
            );

            patchedCount++;
            results.push({
              businessId: publishedId,
              outcome: 'patched',
              changedFields,
            });
          } catch (err: any) {
            failedCount++;
            this.logger.error(
              `[SYNC] business ${publishedId} failed: ${err?.message}`,
            );
            results.push({
              businessId: publishedId,
              outcome: 'failed',
              changedFields: [],
              error: err?.message ?? String(err),
            });
            // continue — never abort batch or run on a single failure
            void recordId;
            void sessionId;
          }
        }

        this.logger.log(
          `[SYNC] Batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(
            eligibleScope.length / BATCH_SIZE,
          )} done`,
        );
      }

      const coverageGap = await this.coverageCheck(
        environment,
        eligibleScope.map((s) => s.publishedId),
      );

      const totals = {
        targeted: scope.length, // raw scope size (all published)
        eligible: eligibleScope.length,
        excluded: excluded.total,
        excludedByReason: excluded.byReason,
        toPatch: patchedCount + failedCount, // attempted
        alreadySynced,
        assertionFailed,
        missingInTarget: missing,
        coverageGap,
        patched: patchedCount,
        failed: failedCount,
      };

      runDoc.status = 'completed';
      runDoc.finishedAt = new Date();
      runDoc.totals = totals as any;
      runDoc.results = results as any;
      await runDoc.save();

      return {
        runId: String(runDoc._id),
        environment,
        totals,
        results,
      };
    } catch (err: any) {
      runDoc.status = 'failed';
      runDoc.finishedAt = new Date();
      runDoc.errorMessage = err?.message ?? String(err);
      await runDoc.save();
      throw err;
    } finally {
      await conn.close();
      if (sourceConn) await sourceConn.close();
    }
  }

  // ── Run history ───────────────────────────────────────────────────────
  async listRuns(environment: string | undefined, limit = 25) {
    const q: Record<string, any> = {};
    if (environment) q.environment = environment;
    return this.runModel
      .find(q)
      .sort({ createdAt: -1 })
      .limit(Math.min(Math.max(limit, 1), 100))
      .lean();
  }
}
