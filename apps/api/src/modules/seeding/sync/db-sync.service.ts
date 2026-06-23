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
      const targetCount = await BusinessModel.countDocuments({
        $or: [{ isFromCrawler: true }, { isCvb: true }],
      });
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

      const pinntagEmail = this.configService.get<string>(
        'app.pinntagBusinessUserEmail',
      );
      const pinntagUser = pinntagEmail
        ? await BusinessUserModel.findOne({ email: pinntagEmail })
            .select('_id')
            .lean()
        : null;

      // alreadySynced lookup in one query
      const stateRows = await this.stateModel
        .find({
          environment,
          syncVersion: DOP_SYNC_VERSION,
          businessId: {
            $in: scopeIds
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

      for (const item of scope) {
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
        const changedFields = Object.keys(businessSet);

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

      const coverageGap = await this.coverageCheck(environment, scopeIds);

      const totals = {
        targeted: scope.length,
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

      const pinntagEmail = this.configService.get<string>(
        'app.pinntagBusinessUserEmail',
      );
      const pinntagUser = pinntagEmail
        ? await BusinessUserModel.findOne({ email: pinntagEmail })
            .select('_id')
            .lean()
        : null;

      for (let i = 0; i < scope.length; i += BATCH_SIZE) {
        const batch = scope.slice(i, i + BATCH_SIZE);

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
            scope.length / BATCH_SIZE,
          )} done`,
        );
      }

      const coverageGap = await this.coverageCheck(
        environment,
        scope.map((s) => s.publishedId),
      );

      const totals = {
        targeted: scope.length,
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
