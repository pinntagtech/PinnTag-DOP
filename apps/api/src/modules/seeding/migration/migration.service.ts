import { HttpException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import mongoose, { Model } from 'mongoose';
import { SeedingSessionService } from '../seeding-session.service';
import { SeedingRecordService } from '../seeding-record.service';
import { SeedingLogService } from '../seeding-log.service';
import { PostPublishService } from '../activation/post-publish.service';
import { DopLinkService } from '../activation/dop-link.service';
import {
  SeedingLogActions,
  SeedingModules,
  SeedingSessionStatus,
  SeedingSessionType,
  SeedingRecordStatus,
  EnvironmentUriKey,
} from '../../../common/constants';
import {
  SeedingRecord,
  SeedingRecordDocument,
} from '../schemas/seeding-record.schema';
import { fullStateName } from '../common/us-states';
import {
  buildSeededBusinessFields,
  hasRealBotCover,
  SEED_DEFAULT_COVER,
  stripManagedFields,
} from '../activation/seed-defaults';

// Strip Mongoose-managed fields from a spread of a lean source doc so
// that target creates get fresh stamps (migration time) and a fresh _id.
function stripMigrationManagedFields(doc: Record<string, any>): void {
  delete doc._id;
  delete doc.__v;
  delete doc.createdAt;
  delete doc.updatedAt;
}

export interface ConflictEntry {
  recordId: string;
  businessName: string;
  placeId: string;
  existingBusinessId: string;
}

export interface CleanEntry {
  recordId: string;
  businessName: string;
  placeId: string;
}

@Injectable()
export class MigrationService {
  private readonly logger = new Logger(MigrationService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly sessionService: SeedingSessionService,
    private readonly recordService: SeedingRecordService,
    private readonly logService: SeedingLogService,
    private readonly postPublishService: PostPublishService,
    private readonly dopLinkService: DopLinkService,
    @InjectModel(SeedingRecord.name)
    private readonly recordModel: Model<SeedingRecordDocument>,
  ) {}

  async checkConflicts(payload: {
    sourceSessionId: string;
    recordIds?: string[];
    targetEnvironment: string;
  }): Promise<{
    conflicts: ConflictEntry[];
    clean: CleanEntry[];
  }> {
    const { sourceSessionId, recordIds, targetEnvironment } = payload;

    const allRecords = await this.recordService
      .findBySessionWithFullData(sourceSessionId, {
        status: SeedingRecordStatus.PUBLISHED,
      });

    const records = recordIds?.length
      ? allRecords.filter((r) =>
          recordIds.includes(r._id.toString()),
        )
      : allRecords;

    const targetUri = this.resolveTargetUri(targetEnvironment);
    const conn = await mongoose
      .createConnection(targetUri)
      .asPromise();

    try {
      const BusinessModel = conn.model(
        'Business',
        new mongoose.Schema<any>({}, { strict: false, timestamps: true }),
        'businesses',
      );

      const conflicts: ConflictEntry[] = [];
      const clean: CleanEntry[] = [];

      for (const record of records) {
        const placeId = record.transformedData?.placeId;
        const name = record.transformedData?.name || 'Unknown';

        if (!placeId) {
          clean.push({
            recordId: record._id.toString(),
            businessName: name,
            placeId: '',
          });
          continue;
        }

        const existing = (await BusinessModel.findOne({ placeId })
          .select('_id name')
          .lean()) as any;

        if (existing) {
          conflicts.push({
            recordId: record._id.toString(),
            businessName: name,
            placeId,
            existingBusinessId: existing._id.toString(),
          });
        } else {
          clean.push({
            recordId: record._id.toString(),
            businessName: name,
            placeId,
          });
        }
      }

      return { conflicts, clean };
    } finally {
      await conn.close();
    }
  }

  // ── Per-business migration primitive ────────────────────────────────
  // Owns the create + taxonomy-by-name + media-copy + activate flow.
  // Used by BOTH the single-session migrate() and cross-session
  // migrateGated(). Caller manages the migration session, shared conn,
  // tallies, and any conflict lookup up front — the helper is stateless
  // per business and never throws (per-record errors are caught and
  // logged as MIGRATION_FAILED). Do NOT fork this — the two callers must
  // stay byte-identical on the create path.
  private async migrateOneBusiness(
    input: {
      recordId: string;
      module: string;
      rawData: any;
      transformedData: any;
      publishedId?: string;
    },
    opts: {
      sourceEnvironment: string;
      targetEnvironment: string;
      migrationSessionId: string;
      sharedActivationConn: mongoose.Connection;
      actor: string;
      resolution: 'skip' | 'overwrite' | null;
    },
  ): Promise<{
    outcome: 'migrated' | 'overwritten' | 'skipped' | 'failed';
    publishedBusinessId?: string;
    mediaCounts: {
      galleryCopied: number;
      menuCopied: number;
      reviewsCopied: number;
    };
    error?: string;
  }> {
    const {
      sourceEnvironment,
      targetEnvironment,
      migrationSessionId,
      sharedActivationConn,
      actor,
      resolution,
    } = opts;
    const emptyMedia = { galleryCopied: 0, menuCopied: 0, reviewsCopied: 0 };

    // ── Skip branch ──
    if (resolution === 'skip') {
      await this.recordService.create({
        sessionId: migrationSessionId,
        module: input.module,
        rawData: input.rawData,
        transformedData: input.transformedData,
        status: SeedingRecordStatus.SKIPPED,
      });
      await this.logService.log({
        sessionId: migrationSessionId,
        action: SeedingLogActions.MIGRATION_RECORD_SKIPPED,
        actor,
        message:
          `Skipped: ${input.transformedData?.name} ` +
          `— already exists in ${targetEnvironment}`,
      });
      return { outcome: 'skipped', mediaCounts: emptyMedia };
    }

    try {
      const placeId = input.transformedData?.placeId;

      const newRecord = await this.recordService.create({
        sessionId: migrationSessionId,
        module: input.module,
        rawData: input.rawData,
        transformedData: input.transformedData,
        status: SeedingRecordStatus.READY,
      });

      // 1. Create business in TARGET DB (per-record conn)
      const targetUri = this.resolveTargetUri(targetEnvironment);
      const conn = await mongoose
        .createConnection(targetUri)
        .asPromise();

      let publishedBusinessId: string;

      try {
        const BusinessModel = conn.model(
          'Business',
          new mongoose.Schema<any>({}, { strict: false, timestamps: true }),
          'businesses',
        );

        // If overwrite — delete existing business first
        if (resolution === 'overwrite') {
          await BusinessModel.deleteOne({ placeId });
          this.logger.log(
            `[MIGRATION] Overwritten business with placeId ` +
              `${placeId} in ${targetEnvironment}`,
          );
        }

        // Read actual business from source environment
        let sourceBusinessDoc: any = null;
        const sourcePublishedId = input.publishedId;

        if (sourcePublishedId) {
          const sourceUri = this.resolveTargetUri(sourceEnvironment);
          const sourceConn = await mongoose
            .createConnection(sourceUri).asPromise();
          try {
            const SrcBusinessModel = sourceConn.model(
              'SrcBizMigrate',
              new mongoose.Schema<any>({}, { strict: false, timestamps: true }),
              'businesses',
            );
            sourceBusinessDoc = await SrcBusinessModel
              .findById(sourcePublishedId)
              .lean();
          } finally {
            await sourceConn.close();
          }
        }

        // Use source business doc if available, fall back to transformedData
        const td = sourceBusinessDoc ||
          (input.transformedData as any);

        // Resolve authorisedUser in target DB
        const BusinessUserModel = conn.model(
          'BusinessUser',
          new mongoose.Schema<any>({}, { strict: false, timestamps: true }),
          'businessusers',
        );

        const adminEmail = this.configService.get<string>(
          'app.pinntagBusinessUserEmail',
        );
        let authorisedUser = (await BusinessUserModel
          .findOne({ email: adminEmail })
          .select('_id')
          .lean()) as any;

        if (!authorisedUser) {
          this.logger.warn(
            `[MIGRATION] Admin user not found in ` +
              `${targetEnvironment}, using source ID`,
          );
          authorisedUser = { _id: td.authorisedUser };
        }

        // Clean up source-specific fields that shouldn't carry over.
        const tdClean: Record<string, any> = { ...(td as any) };
        stripMigrationManagedFields(tdClean);
        delete tdClean.outlets;
        delete tdClean.activatedOutlets;
        delete tdClean.activatedOutletsLength;
        delete tdClean.activeOutletsLength;
        delete tdClean.activeSubscription;
        delete tdClean.drive;
        delete tdClean.galleryPath;
        delete tdClean.selectedBusiness;
        // Source link is bound to the source-env businessId — must be
        // re-minted per target env.
        delete tdClean.appRedirectLink;
        // DOP-internal resolve flags — never migrate.
        delete tdClean.googleCategory;
        delete tdClean.categoryStatus;
        delete tdClean.proposedIndustry;
        delete tdClean.proposedCategories;
        delete tdClean.pendingCoverUrl;

        // Apply canonical seed-field overlay.
        const migrationNow = new Date();
        const businessDoc: Record<string, any> = {
          ...buildSeededBusinessFields(
            tdClean,
            authorisedUser._id as any,
            { hasBotCover: hasRealBotCover(tdClean) },
          ),
          createdAt: migrationNow,
          updatedAt: migrationNow,
        };
        stripManagedFields(businessDoc);
        businessDoc.createdAt = migrationNow;
        businessDoc.updatedAt = migrationNow;

        if (businessDoc.state) {
          businessDoc.state = fullStateName(businessDoc.state);
        }

        // ── Resolve staging industry/category IDs → names ──
        if (sourceBusinessDoc && sourcePublishedId) {
          const resolveSourceUri = this.resolveTargetUri(sourceEnvironment);
          const resolveConn = await mongoose
            .createConnection(resolveSourceUri).asPromise();
          try {
            const SrcIndustry = resolveConn.model(
              'SrcIndustryResolve',
              new mongoose.Schema<any>(
                { name: String, title: String },
                {
                  collection: 'businessindustries',
                  strict: false,
                  timestamps: true,
                },
              ),
            );
            const SrcCategory = resolveConn.model(
              'SrcCategoryResolve',
              new mongoose.Schema<any>(
                { name: String, title: String },
                {
                  collection: 'businesscategories',
                  strict: false,
                  timestamps: true,
                },
              ),
            );

            if (businessDoc.businessIndustry) {
              try {
                const industryDoc = await SrcIndustry.findById(
                  businessDoc.businessIndustry,
                ).lean() as any;
                if (industryDoc) {
                  businessDoc.industry = industryDoc.name ||
                    industryDoc.title;
                  delete businessDoc.businessIndustry;
                  this.logger.log(
                    `[MIGRATION] Resolved industry: ` +
                    `${businessDoc.industry}`,
                  );
                }
              } catch {}
            }

            if (Array.isArray(businessDoc.businessCategories) &&
                businessDoc.businessCategories.length > 0) {
              const categoryNames: string[] = [];
              for (const catId of businessDoc.businessCategories) {
                try {
                  const catDoc = await SrcCategory.findById(catId).lean() as any;
                  if (catDoc) {
                    categoryNames.push(catDoc.name || catDoc.title);
                  }
                } catch {}
              }
              if (categoryNames.length > 0) {
                businessDoc.categories = categoryNames;
                delete businessDoc.businessCategories;
                this.logger.log(
                  `[MIGRATION] Resolved categories: ` +
                  `${categoryNames.join(', ')}`,
                );
              }
            }
          } finally {
            await resolveConn.close();
          }
        }

        // Also ensure string industry/categories from transformedData are
        // preserved (fallback).
        if (!businessDoc.industry && !businessDoc.businessIndustry) {
          if (td.industry) businessDoc.industry = td.industry;
          if (td.categories) businessDoc.categories = td.categories;
        }

        const created = (await BusinessModel.create(businessDoc)) as any;
        publishedBusinessId = created._id.toString();

        this.logger.log(
          `[MIGRATION] Business created in ${targetEnvironment}: ` +
            publishedBusinessId,
        );

        // Mint a FRESH consumer share link for the target env.
        const shareImage =
          created.coverThumbnail ||
          created.cover ||
          businessDoc.cover ||
          SEED_DEFAULT_COVER;
        const appRedirectLink =
          await this.dopLinkService.generateBusinessShareLink(
            publishedBusinessId,
            created.name ?? businessDoc.name,
            shareImage,
          );
        await BusinessModel.updateOne(
          { _id: created._id },
          { $set: { appRedirectLink } },
        );
      } finally {
        await conn.close();
      }

      // 2. Update DOP record with publishedId
      await this.recordService.updateRecord(
        newRecord._id.toString(),
        {
          status: SeedingRecordStatus.PUBLISHED,
          publishedId: publishedBusinessId,
          publishedAt: new Date(),
        },
      );

      // 3. Post-publish activation
      await this.postPublishService.activateBusiness({
        businessId: publishedBusinessId,
        environment: targetEnvironment,
        sessionId: migrationSessionId,
        sharedConnection: sharedActivationConn,
      });

      // 4. Copy gallery, menu, reviews from source DB → target DB
      const sourcePublishedIdForMedia =
        input.publishedId ||
        (input.transformedData as any)?.publishedId;

      let mediaCounts = {
        galleryCopied: 0,
        menuCopied: 0,
        reviewsCopied: 0,
      };

      if (sourcePublishedIdForMedia) {
        mediaCounts = await this.migrateBusinessMedia({
          sourceBusinessId: String(sourcePublishedIdForMedia),
          targetBusinessId: publishedBusinessId,
          sourceEnvironment,
          targetEnvironment,
        });
      }

      // Patch outlet with staging outlet data
      if (sourcePublishedIdForMedia) {
        try {
          const patchSourceUri = this.resolveTargetUri(sourceEnvironment);
          const patchSourceConn = await mongoose
            .createConnection(patchSourceUri).asPromise();
          const patchTargetUri = this.resolveTargetUri(targetEnvironment);
          const patchTargetConn = await mongoose
            .createConnection(patchTargetUri).asPromise();

          try {
            const SrcOutlet = patchSourceConn.model(
              'SrcOutletMigrate',
              new mongoose.Schema<any>({}, { strict: false, timestamps: true }),
              'outlets',
            );
            const TgtOutlet = patchTargetConn.model(
              'TgtOutletMigrate',
              new mongoose.Schema<any>({}, { strict: false, timestamps: true }),
              'outlets',
            );

            const srcOutlet = await SrcOutlet.findOne({
              business: new mongoose.Types.ObjectId(
                sourcePublishedIdForMedia,
              ),
            }).lean() as any;

            if (srcOutlet) {
              const tgtBusinessOid = new mongoose.Types.ObjectId(
                publishedBusinessId,
              );

              const tgtOutlet = await TgtOutlet.findOne({
                business: tgtBusinessOid,
              }).lean() as any;

              if (tgtOutlet) {
                await TgtOutlet.updateOne(
                  { _id: tgtOutlet._id },
                  {
                    $set: {
                      address1: srcOutlet.address1 || tgtOutlet.address1,
                      address2: srcOutlet.address2 || tgtOutlet.address2,
                      city: srcOutlet.city || tgtOutlet.city,
                      state: fullStateName(
                        srcOutlet.state || tgtOutlet.state || '',
                      ),
                      zip: srcOutlet.zip || tgtOutlet.zip,
                      phone: srcOutlet.phone || tgtOutlet.phone,
                      email: srcOutlet.email || tgtOutlet.email,
                      website: srcOutlet.website || tgtOutlet.website,
                    },
                  },
                );
              }
            }
          } finally {
            await patchSourceConn.close();
            await patchTargetConn.close();
          }
        } catch (err: any) {
          this.logger.warn(
            `[MIGRATION] Outlet patch failed: ${err.message}`,
          );
        }
      }

      await this.logService.log({
        sessionId: migrationSessionId,
        action: resolution === 'overwrite'
          ? SeedingLogActions.MIGRATION_RECORD_OVERWRITTEN
          : SeedingLogActions.MIGRATION_RECORD_DONE,
        actor,
        message:
          `Migrated: ${input.transformedData?.name} ` +
          `→ ${targetEnvironment} ` +
          `(${mediaCounts.galleryCopied} gallery, ` +
          `${mediaCounts.menuCopied} menu, ` +
          `${mediaCounts.reviewsCopied} reviews)`,
      });

      return {
        outcome: resolution === 'overwrite' ? 'overwritten' : 'migrated',
        publishedBusinessId,
        mediaCounts,
      };
    } catch (err: any) {
      this.logger.error(
        `Migration failed for record ${input.recordId}: ${err.message}`,
      );
      await this.logService.log({
        sessionId: migrationSessionId,
        action: SeedingLogActions.MIGRATION_FAILED,
        actor,
        message:
          `Failed: ${input.transformedData?.name} — ${err.message}`,
      });
      return { outcome: 'failed', error: err.message, mediaCounts: emptyMedia };
    }
  }

  async migrate(payload: {
    sourceSessionId: string;
    targetEnvironment: string;
    actor: string;
    recordIds?: string[];
    conflictResolution: Record<string, 'skip' | 'overwrite'>;
  }): Promise<{ migrationSessionId: string }> {
    const {
      sourceSessionId,
      targetEnvironment,
      actor,
      recordIds,
      conflictResolution,
    } = payload;

    const sourceSession = await this.sessionService
      .findById(sourceSessionId);

    const migrationSession = await this.sessionService.create({
      name: `[Migration] ${sourceSession.name} → ${targetEnvironment}`,
      environment: targetEnvironment,
      modules: sourceSession.modules,
      createdBy: actor,
    });

    await this.sessionService.updateById(
      migrationSession._id.toString(),
      {
        type: SeedingSessionType.MIGRATION,
        status: SeedingSessionStatus.MIGRATING,
        migratedFrom: {
          sessionId: new mongoose.Types.ObjectId(sourceSessionId),
          sessionName: sourceSession.name,
          environment: sourceSession.environment,
          migratedAt: new Date(),
        },
      },
    );

    const migrationSessionId = migrationSession._id.toString();

    await this.logService.log({
      sessionId: migrationSessionId,
      action: SeedingLogActions.MIGRATION_STARTED,
      actor,
      message:
        `Migration started from session ${sourceSession.name} ` +
        `(${sourceSession.environment}) → ${targetEnvironment}`,
    });

    const allRecords = await this.recordService
      .findBySessionWithFullData(sourceSessionId, {
        status: SeedingRecordStatus.PUBLISHED,
      });

    const records = recordIds?.length
      ? allRecords.filter((r) =>
          recordIds.includes(r._id.toString()),
        )
      : allRecords;

    let migratedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;
    let totalGalleryCopied = 0;
    let totalMenuCopied = 0;
    let totalReviewsCopied = 0;

    // Shared target connection for all activateBusiness calls.
    // Without this, each record opens its own mongoose connection.
    const sharedActivationUri = this.resolveTargetUri(targetEnvironment);
    const sharedActivationConn = await mongoose
      .createConnection(sharedActivationUri)
      .asPromise();

    // Ensure 2dsphere index on target outlets up-front so the first
    // post-publish in the loop doesn't pay for it. Idempotent.
    try {
      await sharedActivationConn
        .collection('outlets')
        .createIndex({ location: '2dsphere' });
    } catch (err: any) {
      this.logger.warn(
        `[MIGRATION] 2dsphere index ensure skipped: ${err?.message}`,
      );
    }

    try {
    for (const record of records) {
      const placeId = record.transformedData?.placeId;
      const rawResolution = placeId
        ? conflictResolution[record._id.toString()]
        : null;
      const resolution: 'skip' | 'overwrite' | null =
        rawResolution === 'skip' || rawResolution === 'overwrite'
          ? rawResolution
          : null;

      const res = await this.migrateOneBusiness(
        {
          recordId: record._id.toString(),
          module: record.module,
          rawData: record.rawData,
          transformedData: record.transformedData,
          publishedId: (record as any).publishedId,
        },
        {
          sourceEnvironment: sourceSession.environment,
          targetEnvironment,
          migrationSessionId,
          sharedActivationConn,
          actor,
          resolution,
        },
      );

      if (res.outcome === 'skipped') {
        skippedCount++;
      } else if (res.outcome === 'failed') {
        failedCount++;
      } else {
        // 'migrated' or 'overwritten'
        migratedCount++;
        totalGalleryCopied += res.mediaCounts.galleryCopied;
        totalMenuCopied += res.mediaCounts.menuCopied;
        totalReviewsCopied += res.mediaCounts.reviewsCopied;
      }
    }
    } finally {
      await sharedActivationConn.close();
    }


    await this.sessionService.updateById(
      migrationSessionId,
      { status: SeedingSessionStatus.MIGRATED },
    );

    try {
      await this.sessionService.pushMigratedTo(sourceSessionId, {
        environment: targetEnvironment,
        sessionId: new mongoose.Types.ObjectId(migrationSessionId),
        migratedAt: new Date(),
      });
    } catch (err: any) {
      this.logger.warn(
        `[MIGRATION] Failed to update source migratedTo: ${err.message}`,
      );
    }

    await this.logService.log({
      sessionId: migrationSessionId,
      action: SeedingLogActions.MIGRATION_COMPLETE,
      actor,
      message:
        `Migration complete — ${migratedCount} migrated, ` +
        `${skippedCount} skipped, ${failedCount} failed | ` +
        `${totalGalleryCopied} gallery files, ` +
        `${totalMenuCopied} menu items, ` +
        `${totalReviewsCopied} reviews`,
    });

    return { migrationSessionId };
  }

  // ── Gated cross-session migration ─────────────────────────────────────
  // The single-session migrate() above is untouched; the methods below
  // add a cross-session batched path that gathers every published seeded
  // business, gates them against 7 quality criteria evaluated on the
  // SOURCE (staging) docs, and reuses migrateOneBusiness for the actual
  // per-business create/activate/media work.

  private static readonly GATED_US_LAT_MIN = 24;
  private static readonly GATED_US_LAT_MAX = 50;
  private static readonly GATED_US_LNG_MIN = -125;
  private static readonly GATED_US_LNG_MAX = -66;
  private static readonly GATED_URL_RE = /^\s*(https?:\/\/|www\.)/i;
  private static readonly GATED_PHONE_RE = /^\+?[\d\s\-().]{7,}$/;
  private static readonly GATED_COUNTY_RE = /county/i;
  private static readonly GATED_GOOGLE_HOST_RE = /googleusercontent/i;
  private static readonly GATED_MEDIA_STAGING_RE =
    /media-staging\.pinntag\.com/i;

  private gatedIsFiniteNumber(v: any): v is number {
    return typeof v === 'number' && Number.isFinite(v);
  }

  private gatedExtractCoords(
    doc: Record<string, any>,
  ): { lat: number; lng: number } | null {
    const lat = this.gatedIsFiniteNumber(doc.latitude)
      ? doc.latitude
      : this.gatedIsFiniteNumber(doc.lat)
        ? doc.lat
        : this.gatedIsFiniteNumber(doc?.location?.coordinates?.[1])
          ? doc.location.coordinates[1]
          : null;
    const lng = this.gatedIsFiniteNumber(doc.longitude)
      ? doc.longitude
      : this.gatedIsFiniteNumber(doc.lng)
        ? doc.lng
        : this.gatedIsFiniteNumber(doc?.location?.coordinates?.[0])
          ? doc.location.coordinates[0]
          : null;
    if (lat === null || lng === null) return null;
    return { lat, lng };
  }

  private gatedEvaluate(
    doc: Record<string, any> | undefined,
    placeIdCounts: Map<string, number>,
  ): { ok: true } | { ok: false; reason: string } {
    if (!doc) return { ok: false, reason: 'missing_source_doc' };

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

    // 1b. verified_placeId — exclude only PROVEN-wrong placeIds
    // (confidence.match === false). Never-scored businesses are already
    // gated out by real_hours (bot_error != 'done') and real_cover;
    // a real B2 cover is itself proof the placeId resolved to a real
    // business, since cover_sync scrapes per-placeId. So absent
    // confidence PASSES here; only an explicit false fails.
    if (doc?.resolveStatus?.confidence?.match === false) {
      return { ok: false, reason: 'unverified_placeId' };
    }

    // 2. real_cover
    const cover = typeof doc.cover === 'string' ? doc.cover : '';
    if (
      !cover ||
      cover === SEED_DEFAULT_COVER ||
      MigrationService.GATED_GOOGLE_HOST_RE.test(cover) ||
      !MigrationService.GATED_MEDIA_STAGING_RE.test(cover)
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
      MigrationService.GATED_URL_RE.test(rawAddr) ||
      MigrationService.GATED_PHONE_RE.test(rawAddr)
    ) {
      return { ok: false, reason: 'valid_address' };
    }
    const city = typeof doc.city === 'string' ? doc.city.trim() : '';
    if (!city || MigrationService.GATED_COUNTY_RE.test(city)) {
      return { ok: false, reason: 'valid_address' };
    }

    // 6. singleton_placeId
    const placeId = typeof doc.placeId === 'string' ? doc.placeId.trim() : '';
    if (!placeId) return { ok: false, reason: 'singleton_placeId' };
    if ((placeIdCounts.get(placeId) ?? 0) > 1) {
      return { ok: false, reason: 'singleton_placeId' };
    }

    // 7. domestic_coords
    const coords = this.gatedExtractCoords(doc);
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
      coords.lat < MigrationService.GATED_US_LAT_MIN ||
      coords.lat > MigrationService.GATED_US_LAT_MAX ||
      coords.lng < MigrationService.GATED_US_LNG_MIN ||
      coords.lng > MigrationService.GATED_US_LNG_MAX
    ) {
      return { ok: false, reason: 'domestic_coords' };
    }

    return { ok: true };
  }

  private async buildGatedMigrationScope(sourceEnv: string): Promise<{
    eligible: Array<{
      publishedId: string;
      placeId: string;
      name: string;
      stagingDoc: Record<string, any>;
    }>;
    totals: {
      publishedTotal: number;
      eligible: number;
      excluded: number;
      excludedByReason: Record<string, number>;
    };
  }> {
    // Source of truth = SOURCE-env `businesses` collection (not DOP
    // published records). The DOP-published path was missing every
    // business that was cleaned directly in the source DB without
    // flowing through the DOP publish pipeline. Reading `businesses`
    // captures that whole cleaned population.
    const sourceUri = this.resolveTargetUri(sourceEnv);
    const sourceConn = await mongoose
      .createConnection(sourceUri)
      .asPromise();

    const byReason: Record<string, number> = {};
    const bump = (r: string) => {
      byReason[r] = (byReason[r] ?? 0) + 1;
    };
    const eligible: Array<{
      publishedId: string;
      placeId: string;
      name: string;
      stagingDoc: Record<string, any>;
    }> = [];
    let publishedTotal = 0;

    try {
      const BusinessModel = sourceConn.model(
        'SrcBizGateStaging',
        new mongoose.Schema<any>({}, { strict: false, timestamps: true }),
        'businesses',
      );

      // Mongo-side gate — every criterion expressible as a query
      // operator runs here. JS supplements below handle the checks
      // Mongo can't cleanly express: URL/phone reject on addressLine1,
      // singleton_placeId dedup, and coords bbox / country / finiteness.
      //
      // Reason keys in `excludedByReason` only cover the JS supplements
      // (`valid_address`, `singleton_placeId`, `domestic_coords`). Docs
      // filtered out by the Mongo query are counted as `publishedTotal
      // − eligible − Σ(reasons)` implicitly — we don't run per-criterion
      // count queries for cost reasons.
      const filter: Record<string, any> = {
        $and: [
          { $or: [{ isFromCrawler: true }, { isCvb: true }] },
          { isActive: true },
          { activatedOutletsLength: { $gte: 1 } },
          { cover: /media-staging\.pinntag\.com/ },
          { 'resolveStatus.hours': 'done' },
          { 'resolveStatus.hoursRaw.0': { $exists: true } },
          { businessIndustry: { $exists: true, $ne: null } },
          { businessCategories: { $exists: true, $not: { $size: 0 } } },
          { addressLine1: { $exists: true, $ne: '' } },
          { city: { $not: /county/i } },
          { placeId: { $exists: true, $ne: '' } },
          { 'resolveStatus.confidence.match': { $ne: false } },
        ],
      };

      // Load full docs — migrateOneBusiness spreads the whole thing via
      // buildSeededBusinessFields, so a projection would truncate.
      const docs = (await BusinessModel.find(filter).lean()) as any[];
      publishedTotal = docs.length;

      // placeId singleton map (dedup over the Mongo-filtered set).
      const placeIdCounts = new Map<string, number>();
      for (const d of docs) {
        const p = typeof d.placeId === 'string' ? d.placeId.trim() : '';
        if (!p) continue;
        placeIdCounts.set(p, (placeIdCounts.get(p) ?? 0) + 1);
      }

      for (const d of docs) {
        // valid_address — URL/phone reject on addressLine1, empty-city.
        // The Mongo filter checked addressLine1 non-empty and city not
        // /county/i, but not URL/phone-shaped addr or empty city.
        const rawAddr =
          typeof d.addressLine1 === 'string' ? d.addressLine1.trim() : '';
        if (
          !rawAddr ||
          MigrationService.GATED_URL_RE.test(rawAddr) ||
          MigrationService.GATED_PHONE_RE.test(rawAddr)
        ) {
          bump('valid_address');
          continue;
        }
        const city = typeof d.city === 'string' ? d.city.trim() : '';
        if (!city) {
          bump('valid_address');
          continue;
        }

        // singleton_placeId — dupes drop ALL copies.
        const placeId =
          typeof d.placeId === 'string' ? d.placeId.trim() : '';
        if (!placeId || (placeIdCounts.get(placeId) ?? 0) > 1) {
          bump('singleton_placeId');
          continue;
        }

        // domestic_coords — finite, not (0,0), country US (if present),
        // within US bbox.
        const coords = this.gatedExtractCoords(d);
        if (!coords || (coords.lat === 0 && coords.lng === 0)) {
          bump('domestic_coords');
          continue;
        }
        const country =
          typeof d.country === 'string' ? d.country.trim() : '';
        if (country && country.toLowerCase() !== 'united states') {
          bump('domestic_coords');
          continue;
        }
        if (
          coords.lat < MigrationService.GATED_US_LAT_MIN ||
          coords.lat > MigrationService.GATED_US_LAT_MAX ||
          coords.lng < MigrationService.GATED_US_LNG_MIN ||
          coords.lng > MigrationService.GATED_US_LNG_MAX
        ) {
          bump('domestic_coords');
          continue;
        }

        eligible.push({
          publishedId: String(d._id),
          placeId,
          name: String(d.name ?? ''),
          stagingDoc: d,
        });
      }
    } finally {
      await sourceConn.close();
    }

    return {
      eligible,
      totals: {
        publishedTotal,
        eligible: eligible.length,
        excluded: publishedTotal - eligible.length,
        excludedByReason: byReason,
      },
    };
  }

  async previewGatedMigration(
    targetEnvironment: string,
    actor: string,
  ): Promise<{
    sourceEnv: string;
    targetEnvironment: string;
    totals: {
      publishedTotal: number;
      eligible: number;
      excluded: number;
      excludedByReason: Record<string, number>;
    };
    conflicts: number;
    willMigrate: number;
    sample: Array<{ name: string; placeId: string; stagingId: string }>;
  }> {
    void actor;
    const sourceEnv = 'staging';
    const { eligible, totals } =
      await this.buildGatedMigrationScope(sourceEnv);

    // Placeholder conflicts count — will be filled below.
    let conflicts = 0;

    if (eligible.length) {
      const targetUri = this.resolveTargetUri(targetEnvironment);
      const targetConn = await mongoose
        .createConnection(targetUri)
        .asPromise();
      try {
        const BusinessModel = targetConn.model(
          'TgtBizConflictCheck',
          new mongoose.Schema<any>({}, { strict: false }),
          'businesses',
        );
        const placeIds = eligible.map((e) => e.placeId).filter(Boolean);
        // Batch the count query — same $in shape works even for 7k ids.
        const existing = (await BusinessModel.find(
          { placeId: { $in: placeIds } },
          { placeId: 1 },
        ).lean()) as any[];
        const existingSet = new Set(existing.map((d) => String(d.placeId)));
        for (const e of eligible) {
          if (existingSet.has(e.placeId)) conflicts++;
        }
      } finally {
        await targetConn.close();
      }
    }

    const willMigrate = Math.max(0, eligible.length - conflicts);
    // sample.stagingId — the source (staging) business _id. Previously
    // sessionId (from the DOP publish path), which no longer applies now
    // that scope comes from staging businesses directly.
    const sample = eligible.slice(0, 20).map((e) => ({
      name: e.name,
      placeId: e.placeId,
      stagingId: e.publishedId,
    }));

    return {
      sourceEnv,
      targetEnvironment,
      totals,
      conflicts,
      willMigrate,
      sample,
    };
  }

  async migrateGated(payload: {
    targetEnvironment: string;
    actor: string;
    adminPassword?: string;
    conflictMode?: 'skip' | 'overwrite';
    limit?: number;
  }): Promise<{
    migrationSessionId: string;
    totals: {
      publishedTotal: number;
      eligible: number;
      conflictsSkipped: number;
      migrated: number;
      failed: number;
    };
  }> {
    const { targetEnvironment, actor, adminPassword } = payload;
    const conflictMode = payload.conflictMode ?? 'skip';

    // production requires admin password (mirrors DbSyncService.applySync).
    if (targetEnvironment === 'production') {
      const expected = this.configService.get<string>('app.dopAdminPassword');
      if (!expected || adminPassword !== expected) {
        throw new HttpException(
          'Invalid admin password for production migration',
          403,
        );
      }
    }

    const sourceEnv = 'staging';
    const { eligible, totals } =
      await this.buildGatedMigrationScope(sourceEnv);

    const capped = payload.limit
      ? eligible.slice(0, Math.max(0, payload.limit))
      : eligible;

    // Create ONE migration session for the whole run.
    const migrationSession = await this.sessionService.create({
      name: `[Gated Migration] ${sourceEnv} → ${targetEnvironment}`,
      environment: targetEnvironment,
      createdBy: actor,
    });
    await this.sessionService.updateById(
      migrationSession._id.toString(),
      {
        type: SeedingSessionType.MIGRATION,
        status: SeedingSessionStatus.MIGRATING,
      },
    );
    const migrationSessionId = migrationSession._id.toString();

    await this.logService.log({
      sessionId: migrationSessionId,
      action: SeedingLogActions.MIGRATION_STARTED,
      actor,
      message:
        `Gated migration started: ${sourceEnv} → ${targetEnvironment} ` +
        `(eligible=${eligible.length}, capped=${capped.length}, ` +
        `mode=${conflictMode})`,
    });

    // Pre-resolve placeId conflicts once (batched).
    const targetUri = this.resolveTargetUri(targetEnvironment);
    const conflictProbeConn = await mongoose
      .createConnection(targetUri)
      .asPromise();
    let conflictPlaceIds = new Set<string>();
    try {
      const Biz = conflictProbeConn.model(
        'TgtBizConflictProbe',
        new mongoose.Schema<any>({}, { strict: false }),
        'businesses',
      );
      const placeIds = capped.map((c) => c.placeId).filter(Boolean);
      if (placeIds.length) {
        const rows = (await Biz.find(
          { placeId: { $in: placeIds } },
          { placeId: 1 },
        ).lean()) as any[];
        conflictPlaceIds = new Set(rows.map((r) => String(r.placeId)));
      }
    } finally {
      await conflictProbeConn.close();
    }

    // Shared activation conn for the loop (same pattern as migrate()).
    const sharedActivationConn = await mongoose
      .createConnection(targetUri)
      .asPromise();
    try {
      try {
        await sharedActivationConn
          .collection('outlets')
          .createIndex({ location: '2dsphere' });
      } catch (err: any) {
        this.logger.warn(
          `[GATED-MIGRATION] 2dsphere index ensure skipped: ${err?.message}`,
        );
      }

      // No DOP-record lookup — scope now sources directly from staging
      // businesses. Normalize the staging business doc into the shape
      // migrateOneBusiness already consumes: transformedData = the raw
      // staging doc (helper strips managed fields + spreads it into the
      // target business via buildSeededBusinessFields), publishedId =
      // staging _id (helper re-reads it as sourceBusinessDoc and uses
      // it for gallery/menu/reviews media copy).
      let conflictsSkipped = 0;
      let migrated = 0;
      let failed = 0;
      let processed = 0;

      for (const c of capped) {
        const inTarget = conflictPlaceIds.has(c.placeId);
        const resolution: 'skip' | 'overwrite' | null = inTarget
          ? conflictMode
          : null;

        const res = await this.migrateOneBusiness(
          {
            recordId: `staging:${c.publishedId}`,
            module: SeedingModules.BUSINESS,
            rawData: c.stagingDoc,
            transformedData: c.stagingDoc,
            publishedId: c.publishedId,
          },
          {
            sourceEnvironment: sourceEnv,
            targetEnvironment,
            migrationSessionId,
            sharedActivationConn,
            actor,
            resolution,
          },
        );

        if (res.outcome === 'skipped') {
          conflictsSkipped++;
        } else if (res.outcome === 'failed') {
          failed++;
        } else {
          migrated++;
        }

        processed++;
        if (processed % 25 === 0) {
          this.logger.log(
            `[GATED-MIGRATION] Progress: ${processed}/${capped.length} ` +
              `(migrated=${migrated}, skipped=${conflictsSkipped}, failed=${failed})`,
          );
        }
      }

      await this.sessionService.updateById(
        migrationSessionId,
        { status: SeedingSessionStatus.MIGRATED },
      );

      await this.logService.log({
        sessionId: migrationSessionId,
        action: SeedingLogActions.MIGRATION_COMPLETE,
        actor,
        message:
          `Gated migration complete — ${migrated} migrated, ` +
          `${conflictsSkipped} skipped, ${failed} failed ` +
          `(publishedTotal=${totals.publishedTotal}, eligible=${totals.eligible})`,
      });

      return {
        migrationSessionId,
        totals: {
          publishedTotal: totals.publishedTotal,
          eligible: totals.eligible,
          conflictsSkipped,
          migrated,
          failed,
        },
      };
    } finally {
      await sharedActivationConn.close();
    }
  }

  // Public so other migration paths (e.g. CvbProdMigrationService)
  // can reuse the same drive/folder/file + menu + review copy logic
  // instead of re-implementing it.
  async migrateBusinessMedia(params: {
    sourceBusinessId: string;
    targetBusinessId: string;
    sourceEnvironment: string;
    targetEnvironment: string;
  }): Promise<{
    galleryCopied: number;
    menuCopied: number;
    reviewsCopied: number;
  }> {
    const sourceUri = this.resolveTargetUri(params.sourceEnvironment);
    const targetUri = this.resolveTargetUri(params.targetEnvironment);

    const sourceConn = await mongoose
      .createConnection(sourceUri)
      .asPromise();
    const targetConn = await mongoose
      .createConnection(targetUri)
      .asPromise();

    let galleryCopied = 0;
    let menuCopied = 0;
    let reviewsCopied = 0;

    try {
      // Schemaless + timestamped — every Tgt*.create below produces fresh
      // migration-time createdAt/updatedAt because we strip the inherited
      // ones from the source spread before calling create.
      const looseSchema = new mongoose.Schema<any>({}, { strict: false, timestamps: true });

      // Source models
      const SrcBusiness = sourceConn.model(
        'SrcBusiness', looseSchema, 'businesses',
      );
      const SrcDrive = sourceConn.model(
        'SrcDrive', looseSchema, 'drives',
      );
      const SrcFolder = sourceConn.model(
        'SrcFolder', looseSchema, 'folders',
      );
      const SrcFile = sourceConn.model(
        'SrcFile', looseSchema, 'files',
      );
      const SrcMenu = sourceConn.model(
        'SrcMenu', looseSchema, 'menus',
      );
      const SrcMenuItem = sourceConn.model(
        'SrcMenuItem', looseSchema, 'menuitems',
      );
      const SrcReview = sourceConn.model(
        'SrcReview', looseSchema, 'reviews',
      );

      // Target models
      const TgtBusiness = targetConn.model(
        'TgtBusiness', looseSchema, 'businesses',
      );
      const TgtFolder = targetConn.model(
        'TgtFolder', looseSchema, 'folders',
      );
      const TgtFile = targetConn.model(
        'TgtFile', looseSchema, 'files',
      );
      const TgtMenu = targetConn.model(
        'TgtMenu', looseSchema, 'menus',
      );
      const TgtMenuItem = targetConn.model(
        'TgtMenuItem', looseSchema, 'menuitems',
      );
      const TgtReview = targetConn.model(
        'TgtReview', looseSchema, 'reviews',
      );

      const srcBusinessOid = new mongoose.Types.ObjectId(
        params.sourceBusinessId,
      );
      const tgtBusinessOid = new mongoose.Types.ObjectId(
        params.targetBusinessId,
      );

      // ── 1. Gallery (Drive → Folders → Files) ───
      const srcBiz = (await SrcBusiness.findById(srcBusinessOid).lean()) as any;

      if (srcBiz?.drive) {
        const srcDrive = (await SrcDrive.findById(srcBiz.drive).lean()) as any;

        if (srcDrive) {
          // Find target business's drive
          const tgtBiz = (await TgtBusiness.findById(tgtBusinessOid).lean()) as any;
          const tgtDriveId = tgtBiz?.drive;

          if (tgtDriveId) {
            // Copy folders
            const srcFolders = (await SrcFolder.find({
              drive: srcDrive._id,
            }).lean()) as any[];

            const folderIdMap = new Map<string, any>();

            for (const folder of srcFolders) {
              const folderData = { ...folder };
              const oldFolderId = folder._id;
              stripMigrationManagedFields(folderData);
              folderData.drive = tgtDriveId;
              folderData.parent = tgtBusinessOid;

              // Remap parentDirectory
              if (folderData.parentDirectory) {
                if (String(folderData.parentDirectory) ===
                    String(srcDrive._id)) {
                  folderData.parentDirectory = tgtDriveId;
                }
                // Subfolder references fixed in second pass
              }

              const newFolder = await TgtFolder.create(folderData);
              folderIdMap.set(String(oldFolderId), newFolder._id);

              // Copy files in this folder
              const srcFiles = (await SrcFile.find({
                parentDirectory: oldFolderId,
              }).lean()) as any[];

              for (const file of srcFiles) {
                const fileData = { ...file };
                stripMigrationManagedFields(fileData);
                fileData.parentDirectory = newFolder._id;
                fileData.parent = tgtBusinessOid;

                await TgtFile.create(fileData);
                galleryCopied++;
              }
            }

            // Second pass: fix subfolder parentDirectory
            for (const [oldId, newId] of folderIdMap.entries()) {
              // Update any folder whose parentDirectory was
              // a source folder ID
              await TgtFolder.updateMany(
                { parentDirectory: new mongoose.Types.ObjectId(oldId) },
                { $set: { parentDirectory: newId } },
              );
            }

            // Also copy files directly under the drive (not in any folder)
            const driveFiles = (await SrcFile.find({
              parent: srcBusinessOid,
              parentDirectory: srcDrive._id,
            }).lean()) as any[];

            for (const file of driveFiles) {
              const fileData = { ...file };
              stripMigrationManagedFields(fileData);
              fileData.parent = tgtBusinessOid;
              fileData.parentDirectory = tgtDriveId;

              await TgtFile.create(fileData);
              galleryCopied++;
            }
          }
        }
      }

      // ── 2. Menu ─────────────────────────────────
      const srcMenus = (await SrcMenu.find({
        business: srcBusinessOid,
      }).lean()) as any[];

      for (const menu of srcMenus) {
        const menuData = { ...menu };
        const oldMenuId = menu._id;
        stripMigrationManagedFields(menuData);
        menuData.business = tgtBusinessOid;

        const newMenu = await TgtMenu.create(menuData);

        // Copy menu items
        const srcItems = (await SrcMenuItem.find({
          menu: oldMenuId,
        }).lean()) as any[];

        for (const item of srcItems) {
          const itemData = { ...item };
          stripMigrationManagedFields(itemData);
          itemData.menu = newMenu._id;
          itemData.business = tgtBusinessOid;

          await TgtMenuItem.create(itemData);
          menuCopied++;
        }
      }

      // ── 3. Reviews ──────────────────────────────
      const srcReviews = (await SrcReview.find({
        business: srcBusinessOid,
      }).lean()) as any[];

      for (const review of srcReviews) {
        const reviewData = { ...review };
        stripMigrationManagedFields(reviewData);
        reviewData.business = tgtBusinessOid;

        await TgtReview.create(reviewData);
        reviewsCopied++;
      }

      // ── 4. Logo/cover sync ──────────────────────
      // Bot post-publish updates logo/cover on the source business doc
      // (not in DOP record.transformedData), so explicitly carry them over.
      if (srcBiz) {
        const logoCoverPatch: Record<string, any> = {};
        if (srcBiz.logo) logoCoverPatch.logo = srcBiz.logo;
        if (srcBiz.logoUploaded !== undefined) {
          logoCoverPatch.logoUploaded = srcBiz.logoUploaded;
        }
        if (srcBiz.cover) logoCoverPatch.cover = srcBiz.cover;
        if (srcBiz.coverUploaded !== undefined) {
          logoCoverPatch.coverUploaded = srcBiz.coverUploaded;
        }
        if (srcBiz.coverStatus) {
          logoCoverPatch.coverStatus = srcBiz.coverStatus;
        }
        if (srcBiz.logoStatus) {
          logoCoverPatch.logoStatus = srcBiz.logoStatus;
        }

        if (Object.keys(logoCoverPatch).length > 0) {
          await TgtBusiness.updateOne(
            { _id: tgtBusinessOid },
            { $set: logoCoverPatch },
          );
        }
      }

      // ── 5. Resolve sync ────────────────────────
      // Resolve writes (regularTiming, upgraded placeId, hoursNote,
      // resolveStatus, rating, userRatingCount) live on the source
      // business doc, not on the DOP record.transformedData. The
      // initial create spread carries them, but we re-patch from a
      // fresh srcBiz read so any resolve update that landed AFTER the
      // seeding record was first transformed still makes it to prod.
      // Mirrors the logo/cover pattern above. (cover + coverStatus
      // are already carried via logoCoverPatch — we don't duplicate
      // them here. pendingCoverUrl is transient and intentionally
      // NOT migrated — it's resolved into a real B2 cover before
      // migration.)
      if (srcBiz) {
        const resolvePatch: Record<string, any> = {};
        if (
          srcBiz.regularTiming &&
          typeof srcBiz.regularTiming === 'object'
        ) {
          resolvePatch.regularTiming = srcBiz.regularTiming;
        }
        if (srcBiz.placeId) {
          resolvePatch.placeId = srcBiz.placeId;
        }
        if (srcBiz.hoursNote) {
          resolvePatch.hoursNote = srcBiz.hoursNote;
        }
        if (srcBiz.resolveStatus) {
          resolvePatch.resolveStatus = srcBiz.resolveStatus;
        }
        if (
          typeof srcBiz.rating === 'number' &&
          Number.isFinite(srcBiz.rating)
        ) {
          resolvePatch.rating = srcBiz.rating;
        }
        if (
          typeof srcBiz.userRatingCount === 'number' &&
          Number.isFinite(srcBiz.userRatingCount)
        ) {
          resolvePatch.userRatingCount = srcBiz.userRatingCount;
        }

        if (Object.keys(resolvePatch).length > 0) {
          await TgtBusiness.updateOne(
            { _id: tgtBusinessOid },
            { $set: resolvePatch },
          );
        }
      }

      this.logger.log(
        `[MIGRATION] Media copied for ${params.targetBusinessId}: ` +
          `${galleryCopied} gallery files, ` +
          `${menuCopied} menu items, ` +
          `${reviewsCopied} reviews`,
      );
    } catch (err: any) {
      this.logger.error(
        `[MIGRATION] Media copy failed: ${err.message}`,
      );
    } finally {
      await sourceConn.close();
      await targetConn.close();
    }

    return { galleryCopied, menuCopied, reviewsCopied };
  }

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
}
