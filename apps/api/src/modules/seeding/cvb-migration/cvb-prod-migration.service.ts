import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import mongoose from 'mongoose';
import { SeedingSessionService } from '../seeding-session.service';
import { SeedingLogService } from '../seeding-log.service';
import { PostPublishService } from '../activation/post-publish.service';
import { MigrationService } from '../migration/migration.service';
import {
  SeedingEnvironments,
  SeedingLogActions,
  SeedingSessionStatus,
  SeedingSessionType,
  EnvironmentUriKey,
} from '../../../common/constants';
import { fullStateName } from '../common/us-states';

// Schemaless + timestamped: writes get fresh createdAt/updatedAt.
const LOOSE_SCHEMA = new mongoose.Schema<any>(
  {},
  { strict: false, timestamps: true },
);

// Same widened CVB pool used elsewhere in the seeding module:
// isCvb OR isFromCrawler, excluding soft-deleted docs.
const CVB_BASE_FILTER = {
  $or: [{ isCvb: true }, { isFromCrawler: true }],
  isDeleted: { $ne: true },
};

const MIGRATE_BATCH_SIZE = 50;
const PROD_LOOKUP_BATCH_SIZE = 500;

function normalizeName(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeCity(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase();
}

// Strip protocol + leading "www." and isolate the registrable domain.
// "https://www.foo.com/x" → "foo.com"; "" → "".
function extractRootDomain(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return '';
  let host = value.trim().toLowerCase();
  host = host.replace(/^https?:\/\//, '');
  host = host.split('/')[0];
  host = host.replace(/^www\./, '');
  if (!host) return '';
  const parts = host.split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  // Registrable domain ≈ last two labels. Good enough for matching
  // brand websites; this is not a public-suffix-list implementation.
  return parts.slice(-2).join('.');
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

function stripMigrationManagedFields(doc: Record<string, any>): void {
  delete doc._id;
  delete doc.__v;
  delete doc.createdAt;
  delete doc.updatedAt;
}

interface StagingLeanBusiness {
  _id: mongoose.Types.ObjectId;
  name?: string;
  placeId?: string | null;
  city?: string;
  state?: string;
  country?: string;
  phone?: string;
  email?: string;
  website?: string;
  logo?: string;
  cover?: string;
  rating?: number;
  userRatingCount?: number;
  businessIndustry?: mongoose.Types.ObjectId;
  businessCategories?: mongoose.Types.ObjectId[];
  industryName?: string;
  categoryNames?: string[];
  hasMedia?: boolean;
}

interface NotInProdListFilters {
  city?: string;
  state?: string;
  industry?: string;
  category?: string;
  search?: string;
  page?: number;
  limit?: number;
}

interface MigrateFilters extends NotInProdListFilters {}

interface MigrateRequest {
  businessIds?: string[];
  filters?: MigrateFilters;
  dryRun: boolean;
  actor: string;
}

export interface CvbProdMigrationDryRunResult {
  dryRun: true;
  total: number;
  wouldMigrate: number;
  skippedAlreadyInProd: number;
  wouldMergeAsOutlet: number;
  wouldCreateStandalone: number;
  withMedia: number;
}

export interface CvbProdMigrationLiveRunResult {
  dryRun: false;
  total: number;
  migrated: number;
  skippedAlreadyInProd: number;
  mergedAsOutlet: number;
  createdStandalone: number;
  mediaCopied: number;
  failed: number;
  errors: { businessId: string; name: string; error: string }[];
  migrationSessionId: string;
}

export type CvbProdMigrationResult =
  | CvbProdMigrationDryRunResult
  | CvbProdMigrationLiveRunResult;

@Injectable()
export class CvbProdMigrationService {
  private readonly logger = new Logger(CvbProdMigrationService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly sessionService: SeedingSessionService,
    private readonly logService: SeedingLogService,
    private readonly postPublishService: PostPublishService,
    private readonly migrationService: MigrationService,
  ) {}

  // ────────────────────────────────────────────────────────────
  // PUBLIC: list staging CVB/crawler businesses not yet in prod
  // ────────────────────────────────────────────────────────────
  async listNotInProd(filters: NotInProdListFilters): Promise<{
    businesses: any[];
    total: number;
    page: number;
    pages: number;
  }> {
    const stagingUri = this.requireUri(SeedingEnvironments.STAGING);
    const prodUri = this.requireUri(SeedingEnvironments.PRODUCTION);

    const page = filters.page || 1;
    const limit = Math.min(filters.limit || 20, 100);

    const stagingConn = await mongoose
      .createConnection(stagingUri)
      .asPromise();
    const prodConn = await mongoose
      .createConnection(prodUri)
      .asPromise();

    try {
      const StagingBiz = stagingConn.model(
        'StagingBusinessNotInProd',
        LOOSE_SCHEMA,
        'businesses',
      );
      const ProdBiz = prodConn.model(
        'ProdBusinessNotInProd',
        LOOSE_SCHEMA,
        'businesses',
      );

      const stagingQuery = this.buildStagingQuery(filters);

      // Pull only the fields we need for the dedup decision + the
      // display row. Cap at 10000 to keep memory bounded; with the
      // current pool (~12.8k) this covers a full filtered slice.
      const allMatching = (await StagingBiz.find(stagingQuery)
        .select(
          '_id name placeId city state country phone email website ' +
            'logo cover rating userRatingCount ' +
            'businessIndustry businessCategories ' +
            'drive createdAt',
        )
        .sort({ createdAt: -1 })
        .limit(10000)
        .lean()) as unknown as StagingLeanBusiness[];

      const inProdIds = await this.findInProdStagingIds(allMatching, ProdBiz);
      const notInProd = allMatching.filter(
        (b) => !inProdIds.has(String(b._id)),
      );

      const total = notInProd.length;
      const pages = Math.max(1, Math.ceil(total / limit));
      const slice = notInProd.slice((page - 1) * limit, page * limit);

      const enriched = await this.enrichWithTaxonomyNames(
        slice,
        stagingConn,
      );

      return { businesses: enriched, total, page, pages };
    } finally {
      await stagingConn.close();
      await prodConn.close();
    }
  }

  // ────────────────────────────────────────────────────────────
  // PUBLIC: migrate staging → prod (dry-run OR live)
  // ────────────────────────────────────────────────────────────
  async migrateToProd(
    req: MigrateRequest,
  ): Promise<CvbProdMigrationResult> {
    const { businessIds, filters, dryRun, actor } = req;

    const stagingUri = this.requireUri(SeedingEnvironments.STAGING);
    const prodUri = this.requireUri(SeedingEnvironments.PRODUCTION);

    const stagingConn = await mongoose
      .createConnection(stagingUri)
      .asPromise();
    // Shared prod connection — reused across activateBusiness calls
    // and for our own dedup/insert work. Closed in finally.
    const prodConn = await mongoose
      .createConnection(prodUri)
      .asPromise();

    // Create a migration-type session in PROD so the run is auditable
    // (logs attach to it). Even dry runs get a session so the dry-run
    // attempt is traceable — but we mark it status=CANCELLED for dry.
    const migrationSession = await this.sessionService.create({
      name: `[CVB→Prod ${dryRun ? 'DRY' : 'LIVE'}] ${new Date()
        .toISOString()
        .replace('T', ' ')
        .slice(0, 16)}`,
      environment: SeedingEnvironments.PRODUCTION,
      modules: ['business'],
      createdBy: actor,
    });
    const migrationSessionId = migrationSession._id.toString();

    await this.sessionService.updateById(migrationSessionId, {
      type: SeedingSessionType.MIGRATION,
      status: SeedingSessionStatus.MIGRATING,
    });

    await this.logService.log({
      sessionId: migrationSessionId,
      action: SeedingLogActions.MIGRATION_STARTED,
      actor,
      message:
        `[CVB→PROD] ${dryRun ? 'Dry-run' : 'Live'} migration started` +
        (businessIds?.length
          ? ` for ${businessIds.length} explicit IDs`
          : ' for filtered set'),
    });

    try {
      const StagingBiz = stagingConn.model(
        'StagingBusinessCvbMigrate',
        LOOSE_SCHEMA,
        'businesses',
      );
      const StagingIndustry = stagingConn.model(
        'StagingIndustryCvbMigrate',
        LOOSE_SCHEMA,
        'businessindustries',
      );
      const StagingCategory = stagingConn.model(
        'StagingCategoryCvbMigrate',
        LOOSE_SCHEMA,
        'businesscategories',
      );
      const StagingDrive = stagingConn.model(
        'StagingDriveCvbMigrate',
        LOOSE_SCHEMA,
        'drives',
      );
      const StagingFolder = stagingConn.model(
        'StagingFolderCvbMigrate',
        LOOSE_SCHEMA,
        'folders',
      );
      const StagingMenu = stagingConn.model(
        'StagingMenuCvbMigrate',
        LOOSE_SCHEMA,
        'menus',
      );
      const StagingReview = stagingConn.model(
        'StagingReviewCvbMigrate',
        LOOSE_SCHEMA,
        'reviews',
      );
      const ProdBiz = prodConn.model(
        'ProdBusinessCvbMigrate',
        LOOSE_SCHEMA,
        'businesses',
      );
      const ProdBusinessUser = prodConn.model(
        'ProdBusinessUserCvbMigrate',
        LOOSE_SCHEMA,
        'businessusers',
      );

      // 1) Resolve the working set of staging _ids.
      const stagingObjectIds: mongoose.Types.ObjectId[] =
        await this.resolveWorkingSetIds(
          { businessIds, filters },
          StagingBiz,
        );

      // 2) Pre-resolve the prod PinnTag BusinessUser once.
      const pinntagUserEmail = this.configService.get<string>(
        'app.pinntagBusinessUserEmail',
      );
      const pinntagUser = pinntagUserEmail
        ? ((await ProdBusinessUser.findOne({
            email: pinntagUserEmail,
          })
            .select('_id')
            .lean()) as any)
        : null;

      // Counters
      let wouldMigrate = 0;
      let skippedAlreadyInProd = 0;
      let wouldMergeAsOutlet = 0;
      let wouldCreateStandalone = 0;
      let withMedia = 0;
      let migrated = 0;
      let mergedAsOutlet = 0;
      let createdStandalone = 0;
      let mediaCopied = 0;
      let failed = 0;
      const errors: { businessId: string; name: string; error: string }[] =
        [];

      const total = stagingObjectIds.length;
      const batches = chunk(stagingObjectIds, MIGRATE_BATCH_SIZE);

      for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
        const batchIds = batches[batchIdx];

        // Load only this batch from staging.
        const batchDocs = (await StagingBiz.find({
          _id: { $in: batchIds },
          ...CVB_BASE_FILTER,
        }).lean()) as any[];

        // Re-check not-in-prod for this exact batch (race-safe).
        const inProdIds = await this.findInProdStagingIds(
          batchDocs as StagingLeanBusiness[],
          ProdBiz,
        );

        for (const biz of batchDocs) {
          const stagingId = String(biz._id);
          const bizName = biz.name || '(unnamed)';

          if (inProdIds.has(stagingId)) {
            skippedAlreadyInProd++;
            continue;
          }

          // ── (b) industry / category → NAMES ──
          let industryName: string | null = null;
          let categoryNames: string[] = [];
          try {
            if (biz.businessIndustry) {
              const indDoc = (await StagingIndustry.findById(
                biz.businessIndustry,
              ).lean()) as any;
              if (indDoc) {
                industryName =
                  indDoc.title || indDoc.name || null;
              }
            }
            if (Array.isArray(biz.businessCategories)) {
              for (const catId of biz.businessCategories) {
                const catDoc = (await StagingCategory.findById(
                  catId,
                ).lean()) as any;
                if (catDoc) {
                  categoryNames.push(
                    catDoc.title || catDoc.name,
                  );
                }
              }
            }
          } catch (err: any) {
            this.logger.warn(
              `[CVB→PROD] taxonomy resolve failed for ` +
                `${stagingId}: ${err.message}`,
            );
          }

          // ── (c) Build the prod business doc ──
          const tdClean: Record<string, any> = { ...biz };
          stripMigrationManagedFields(tdClean);
          delete tdClean.outlets;
          delete tdClean.activeSubscription;
          delete tdClean.drive;
          delete tdClean.galleryPath;
          delete tdClean.selectedBusiness;
          delete tdClean.activatedOutletsLength;
          delete tdClean.isLocationOf;
          delete tdClean.businessIndustry;
          delete tdClean.businessCategories;

          const now = new Date();
          const businessDoc: Record<string, any> = {
            ...tdClean,
            // industry/category as NAMES — activateBusiness resolves
            // these against the prod taxonomy.
            ...(industryName ? { industry: industryName } : {}),
            ...(categoryNames.length > 0
              ? { categories: categoryNames }
              : {}),
            // logo/cover/uploaded/status fields carry as-is from
            // tdClean (intentional — covered by the spec).
            isFromCrawler: true,
            dataFetchedFromGoogle: true,
            status: 4.1,
            isActive: true,
            isClaimed: false,
            isDeleted: false,
            followersCount: 0,
            followingCount: 0,
            viewsCount: 0,
            boostOrder: 1000,
            creatorType: 'Admin',
            createdAt: now,
            updatedAt: now,
          };
          if (businessDoc.state) {
            businessDoc.state = fullStateName(businessDoc.state);
          }
          if (pinntagUser?._id) {
            businessDoc.authorisedUser = pinntagUser._id;
          }

          // ── (d) STRICT same-business: name + website-domain ──
          const merge = await this.resolveStrictMergeParent(
            biz,
            ProdBiz,
          );

          // Detect media presence (gallery/menus/reviews) — used for
          // both dry-run "withMedia" stat and live "mediaCopied".
          const hasMedia = await this.detectMedia(
            biz,
            { StagingDrive, StagingFolder, StagingMenu, StagingReview },
          );

          if (dryRun) {
            wouldMigrate++;
            if (merge.parentBusinessId) wouldMergeAsOutlet++;
            else wouldCreateStandalone++;
            if (hasMedia) withMedia++;
            continue;
          }

          // ── (e) LIVE: insert + activate ──
          try {
            const inserted = (await ProdBiz.create(businessDoc)) as any;
            const newProdId = String(inserted._id);

            const activateResult =
              await this.postPublishService.activateBusiness({
                businessId: newProdId,
                environment: SeedingEnvironments.PRODUCTION,
                sessionId: migrationSessionId,
                sharedConnection: prodConn,
                ...(merge.parentBusinessId
                  ? { parentBusinessId: merge.parentBusinessId }
                  : { forceStandalone: true }),
              });

            if (!activateResult.success) {
              throw new Error(activateResult.message);
            }

            if (merge.parentBusinessId) mergedAsOutlet++;
            else createdStandalone++;

            // ── (f) MEDIA copy via reused MigrationService helper ──
            if (hasMedia) {
              try {
                const counts =
                  await this.migrationService.migrateBusinessMedia({
                    sourceBusinessId: stagingId,
                    targetBusinessId: newProdId,
                    sourceEnvironment: SeedingEnvironments.STAGING,
                    targetEnvironment: SeedingEnvironments.PRODUCTION,
                  });
                if (
                  counts.galleryCopied +
                    counts.menuCopied +
                    counts.reviewsCopied >
                  0
                ) {
                  mediaCopied++;
                }
              } catch (mediaErr: any) {
                this.logger.warn(
                  `[CVB→PROD] media copy failed for ${stagingId}: ` +
                    mediaErr.message,
                );
              }
            }

            migrated++;
          } catch (err: any) {
            failed++;
            errors.push({
              businessId: stagingId,
              name: bizName,
              error: err.message || String(err),
            });
            this.logger.error(
              `[CVB→PROD] migrate failed for ${stagingId}: ${err.message}`,
            );
            await this.logService.log({
              sessionId: migrationSessionId,
              action: SeedingLogActions.MIGRATION_FAILED,
              actor,
              message:
                `Failed: ${bizName} (${stagingId}) — ${err.message}`,
            });
          }
        }

        await this.logService.log({
          sessionId: migrationSessionId,
          action: dryRun
            ? SeedingLogActions.MIGRATION_STARTED
            : SeedingLogActions.MIGRATION_RECORD_DONE,
          actor,
          message:
            `Batch ${batchIdx + 1}/${batches.length} ` +
            (dryRun
              ? `(dry) — would-migrate=${wouldMigrate}, ` +
                `skipped=${skippedAlreadyInProd}`
              : `(live) — migrated=${migrated}, ` +
                `skipped=${skippedAlreadyInProd}, failed=${failed}`),
        });
      }

      // Wrap up the session
      await this.sessionService.updateById(migrationSessionId, {
        status: dryRun
          ? SeedingSessionStatus.CANCELLED
          : SeedingSessionStatus.MIGRATED,
      });

      await this.logService.log({
        sessionId: migrationSessionId,
        action: SeedingLogActions.MIGRATION_COMPLETE,
        actor,
        message: dryRun
          ? `[DRY] would-migrate=${wouldMigrate}, ` +
            `merge-as-outlet=${wouldMergeAsOutlet}, ` +
            `standalone=${wouldCreateStandalone}, ` +
            `with-media=${withMedia}, ` +
            `already-in-prod=${skippedAlreadyInProd}`
          : `[LIVE] migrated=${migrated}, ` +
            `merged=${mergedAsOutlet}, standalone=${createdStandalone}, ` +
            `media=${mediaCopied}, skipped=${skippedAlreadyInProd}, ` +
            `failed=${failed}`,
      });

      if (dryRun) {
        return {
          dryRun: true,
          total,
          wouldMigrate,
          skippedAlreadyInProd,
          wouldMergeAsOutlet,
          wouldCreateStandalone,
          withMedia,
        };
      }
      return {
        dryRun: false,
        total,
        migrated,
        skippedAlreadyInProd,
        mergedAsOutlet,
        createdStandalone,
        mediaCopied,
        failed,
        errors,
        migrationSessionId,
      };
    } finally {
      await stagingConn.close();
      await prodConn.close();
    }
  }

  // ────────────────────────────────────────────────────────────
  // INTERNAL HELPERS
  // ────────────────────────────────────────────────────────────
  private requireUri(environment: string): string {
    const uriKey =
      EnvironmentUriKey[
        environment as keyof typeof EnvironmentUriKey
      ];
    if (!uriKey) {
      throw new Error(`Unknown environment: ${environment}`);
    }
    const uri = this.configService.get<string>(uriKey);
    if (!uri) {
      throw new Error(`No URI configured for: ${environment}`);
    }
    return uri;
  }

  private buildStagingQuery(
    filters: NotInProdListFilters,
  ): Record<string, any> {
    const query: Record<string, any> = {
      isDeleted: { $ne: true },
      $and: [
        {
          $or: [{ isCvb: true }, { isFromCrawler: true }],
        },
      ],
    };
    if (filters.city) {
      query.city = new RegExp(filters.city, 'i');
    }
    if (filters.state) {
      query.state = new RegExp(filters.state, 'i');
    }
    if (filters.industry) {
      query.businessIndustry = new mongoose.Types.ObjectId(
        filters.industry,
      );
    }
    if (filters.category) {
      query.businessCategories = {
        $in: [new mongoose.Types.ObjectId(filters.category)],
      };
    }
    if (filters.search) {
      query.$and.push({
        $or: [
          { name: new RegExp(filters.search, 'i') },
          { email: new RegExp(filters.search, 'i') },
          { phone: new RegExp(filters.search, 'i') },
        ],
      });
    }
    return query;
  }

  // Build the set of staging _ids that are ALREADY in prod, by:
  //   (1) placeId match — for staging docs with a placeId, OR
  //   (2) normalized name + normalized city — for those without.
  // Uses batched $in queries; never per-business round-trips.
  private async findInProdStagingIds(
    stagingDocs: StagingLeanBusiness[],
    ProdBiz: mongoose.Model<any>,
  ): Promise<Set<string>> {
    const inProd = new Set<string>();
    if (stagingDocs.length === 0) return inProd;

    // (1) placeId-based.
    const placeIdToStagingIds = new Map<string, string[]>();
    for (const b of stagingDocs) {
      if (b.placeId) {
        const list =
          placeIdToStagingIds.get(b.placeId) || [];
        list.push(String(b._id));
        placeIdToStagingIds.set(b.placeId, list);
      }
    }
    const placeIds = [...placeIdToStagingIds.keys()];
    for (const batch of chunk(placeIds, PROD_LOOKUP_BATCH_SIZE)) {
      const found = (await ProdBiz.find({
        placeId: { $in: batch },
      })
        .select('placeId')
        .lean()) as any[];
      for (const f of found) {
        const ids = placeIdToStagingIds.get(f.placeId);
        if (ids) ids.forEach((id) => inProd.add(id));
      }
    }

    // (2) name+city-based for placeless staging docs only.
    const nameKeyToStagingIds = new Map<string, string[]>();
    const placelessNames = new Set<string>();
    for (const b of stagingDocs) {
      if (b.placeId) continue;
      const nName = normalizeName(b.name);
      const nCity = normalizeCity(b.city);
      if (!nName) continue;
      const key = `${nName}|${nCity}`;
      const list = nameKeyToStagingIds.get(key) || [];
      list.push(String(b._id));
      nameKeyToStagingIds.set(key, list);
      if (b.name) placelessNames.add(b.name);
    }

    const nameArr = [...placelessNames];
    for (const batch of chunk(nameArr, 100)) {
      // Case-insensitive exact match via per-name regex.
      const patterns = batch.map(
        (n) => new RegExp(`^${escapeRegex(n)}$`, 'i'),
      );
      const found = (await ProdBiz.find({
        name: { $in: patterns },
      })
        .select('name city')
        .lean()) as any[];
      for (const f of found) {
        const key = `${normalizeName(f.name)}|${normalizeCity(
          f.city,
        )}`;
        const ids = nameKeyToStagingIds.get(key);
        if (ids) ids.forEach((id) => inProd.add(id));
      }
    }

    return inProd;
  }

  // STRICT same-business resolution. Returns either a parent prod _id
  // (when name normalized matches AND website root domain matches),
  // or null (treat as distinct standalone). NEVER merges on name alone.
  private async resolveStrictMergeParent(
    stagingBiz: any,
    ProdBiz: mongoose.Model<any>,
  ): Promise<{ parentBusinessId: string | null }> {
    const name = stagingBiz.name as string | undefined;
    if (!name) return { parentBusinessId: null };

    const stagingDomain = extractRootDomain(stagingBiz.website);
    if (!stagingDomain) {
      // No website on staging side → cannot prove same-business.
      return { parentBusinessId: null };
    }

    const candidates = (await ProdBiz.find({
      name: { $regex: new RegExp(`^${escapeRegex(name)}$`, 'i') },
      isDeleted: { $ne: true },
    })
      .select('_id name website')
      .lean()) as any[];

    for (const c of candidates) {
      const prodDomain = extractRootDomain(c.website);
      if (prodDomain && prodDomain === stagingDomain) {
        return { parentBusinessId: String(c._id) };
      }
    }
    return { parentBusinessId: null };
  }

  // Cheap check — just looks at presence of media-related docs.
  // Doesn't load them.
  private async detectMedia(
    stagingBiz: any,
    models: {
      StagingDrive: mongoose.Model<any>;
      StagingFolder: mongoose.Model<any>;
      StagingMenu: mongoose.Model<any>;
      StagingReview: mongoose.Model<any>;
    },
  ): Promise<boolean> {
    try {
      if (stagingBiz.drive) {
        const drive = await models.StagingDrive.findById(
          stagingBiz.drive,
        )
          .select('_id')
          .lean();
        if (drive) {
          const folder = await models.StagingFolder.findOne({
            drive: (drive as any)._id,
          })
            .select('_id')
            .lean();
          if (folder) return true;
        }
      }
      const menu = await models.StagingMenu.findOne({
        business: stagingBiz._id,
      })
        .select('_id')
        .lean();
      if (menu) return true;
      const review = await models.StagingReview.findOne({
        business: stagingBiz._id,
      })
        .select('_id')
        .lean();
      if (review) return true;
    } catch {
      // Detection is best-effort; missing media doesn't fail migration.
    }
    return false;
  }

  private async resolveWorkingSetIds(
    req: { businessIds?: string[]; filters?: MigrateFilters },
    StagingBiz: mongoose.Model<any>,
  ): Promise<mongoose.Types.ObjectId[]> {
    if (req.businessIds?.length) {
      // Explicit IDs — trust the caller but still enforce CVB filter
      // so we never act on non-CVB docs even if someone supplies them.
      const docs = (await StagingBiz.find({
        _id: {
          $in: req.businessIds.map(
            (id) => new mongoose.Types.ObjectId(id),
          ),
        },
        ...CVB_BASE_FILTER,
      })
        .select('_id')
        .lean()) as any[];
      return docs.map((d) => d._id);
    }

    const filters = req.filters || {};
    const query = this.buildStagingQuery(filters);
    const docs = (await StagingBiz.find(query)
      .select('_id')
      .limit(10000)
      .lean()) as any[];
    return docs.map((d) => d._id);
  }

  // Resolve industry/category ObjectIds → names just for the response
  // rows of listNotInProd (display purposes).
  private async enrichWithTaxonomyNames(
    rows: StagingLeanBusiness[],
    stagingConn: mongoose.Connection,
  ): Promise<any[]> {
    if (rows.length === 0) return [];
    const Industry = stagingConn.model(
      'StagingIndustryNotInProdEnrich',
      LOOSE_SCHEMA,
      'businessindustries',
    );
    const Category = stagingConn.model(
      'StagingCategoryNotInProdEnrich',
      LOOSE_SCHEMA,
      'businesscategories',
    );

    const industryIds = [
      ...new Set(
        rows
          .map((r) => r.businessIndustry?.toString())
          .filter(Boolean) as string[],
      ),
    ];
    const categoryIds = [
      ...new Set(
        rows.flatMap((r) =>
          (r.businessCategories || []).map((c) => c.toString()),
        ),
      ),
    ];

    const [industries, categories] = await Promise.all([
      industryIds.length
        ? Industry.find({
            _id: {
              $in: industryIds.map(
                (id) => new mongoose.Types.ObjectId(id),
              ),
            },
          })
            .select('_id title name')
            .lean()
        : Promise.resolve([]),
      categoryIds.length
        ? Category.find({
            _id: {
              $in: categoryIds.map(
                (id) => new mongoose.Types.ObjectId(id),
              ),
            },
          })
            .select('_id title name')
            .lean()
        : Promise.resolve([]),
    ]);

    const indMap = new Map<string, string>(
      (industries as any[]).map((i) => [
        String(i._id),
        i.title || i.name || 'Unknown',
      ]),
    );
    const catMap = new Map<string, string>(
      (categories as any[]).map((c) => [
        String(c._id),
        c.title || c.name || 'Unknown',
      ]),
    );

    return rows.map((r) => ({
      ...r,
      industryName: r.businessIndustry
        ? indMap.get(String(r.businessIndustry))
        : null,
      categoryNames: (r.businessCategories || [])
        .map((c) => catMap.get(String(c)))
        .filter(Boolean),
    }));
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
