import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import mongoose from 'mongoose';
import { SeedingSessionService } from '../seeding-session.service';
import { SeedingRecordService } from '../seeding-record.service';
import { SeedingLogService } from '../seeding-log.service';
import { PostPublishService } from '../activation/post-publish.service';
import { DopLinkService } from '../activation/dop-link.service';
import {
  SeedingLogActions,
  SeedingSessionStatus,
  SeedingSessionType,
  SeedingRecordStatus,
  EnvironmentUriKey,
} from '../../../common/constants';
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
      try {
        const placeId = record.transformedData?.placeId;
        const resolution = placeId
          ? conflictResolution[record._id.toString()]
          : null;

        if (resolution === 'skip') {
          await this.recordService.create({
            sessionId: migrationSessionId,
            module: record.module,
            rawData: record.rawData,
            transformedData: record.transformedData,
            status: SeedingRecordStatus.SKIPPED,
          });

          await this.logService.log({
            sessionId: migrationSessionId,
            action: SeedingLogActions.MIGRATION_RECORD_SKIPPED,
            actor,
            message:
              `Skipped: ${record.transformedData?.name} ` +
              `— already exists in ${targetEnvironment}`,
          });

          skippedCount++;
          continue;
        }

        const newRecord = await this.recordService.create({
          sessionId: migrationSessionId,
          module: record.module,
          rawData: record.rawData,
          transformedData: record.transformedData,
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
          const sourcePublishedId = (record as any).publishedId;

          if (sourcePublishedId) {
            const sourceUri = this.resolveTargetUri(
              sourceSession.environment,
            );
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

          // Use source business doc if available,
          // fall back to transformedData
          const td = sourceBusinessDoc ||
            (record.transformedData as any);

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
          // Strip Mongoose-managed fields (_id/__v/timestamps) up-front so
          // our migration-time stamps below are not overridden, and drop
          // every relation that gets re-created by activateBusiness.
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
          // DOP-internal resolve flags — never migrate. The taxonomy
          // gets carried as businessIndustry/businessCategories
          // (resolved-by-name below); googleCategory + the
          // categoryStatus / proposed* trio are operator-facing
          // signals only. pendingCoverUrl is similarly transient —
          // it's been swapped to a real B2 cover before migration.
          delete tdClean.googleCategory;
          delete tdClean.categoryStatus;
          delete tdClean.proposedIndustry;
          delete tdClean.proposedCategories;
          delete tdClean.pendingCoverUrl;

          // Apply canonical seed-field overlay. Same helper as
          // PostPublishService so a migrated business is byte-identical
          // to one created via the normal publish path.
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
          // re-apply the migration-time stamps after stripping.
          businessDoc.createdAt = migrationNow;
          businessDoc.updatedAt = migrationNow;

          // Convert state → canonical full name at the write boundary.
          if (businessDoc.state) {
            businessDoc.state = fullStateName(businessDoc.state);
          }

          // Keep industry/categories for resolution
          // (don't delete here — post-publish resolves them)

          // ── Resolve staging industry/category IDs → names ──
          // Staging and production have different ObjectIds for
          // the same industry/category names. We need to look
          // up the NAME from staging, then let post-publish
          // resolve the name to the correct production ObjectId.
          if (sourceBusinessDoc && sourcePublishedId) {
            const resolveSourceUri = this.resolveTargetUri(
              sourceSession.environment,
            );
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

              // Resolve industry ObjectId → name
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

              // Resolve category ObjectIds → names
              if (Array.isArray(businessDoc.businessCategories) &&
                  businessDoc.businessCategories.length > 0) {
                const categoryNames: string[] = [];
                for (const catId of businessDoc.businessCategories) {
                  try {
                    const catDoc = await SrcCategory.findById(
                      catId,
                    ).lean() as any;
                    if (catDoc) {
                      categoryNames.push(
                        catDoc.name || catDoc.title,
                      );
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

          // Also ensure string industry/categories from
          // transformedData are preserved (fallback)
          if (!businessDoc.industry && !businessDoc.businessIndustry) {
            if (td.industry) businessDoc.industry = td.industry;
            if (td.categories) businessDoc.categories = td.categories;
          }

          const created = (await BusinessModel.create(
            businessDoc,
          )) as any;
          publishedBusinessId = created._id.toString();

          this.logger.log(
            `[MIGRATION] Business created in ${targetEnvironment}: ` +
              publishedBusinessId,
          );

          // Mint a FRESH consumer share link for the target env. Never
          // copy the source link — the domain/businessId differ per env.
          // The link service has a long-URL fallback so this never throws.
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

        // 3. Run post-publish activation
        // (creates outlet, subscription, drive, gallery,
        //  uploads logo/cover)
        await this.postPublishService.activateBusiness({
          businessId: publishedBusinessId,
          environment: targetEnvironment,
          sessionId: migrationSessionId,
          sharedConnection: sharedActivationConn,
        });

        // 4. Copy gallery, menu, reviews from source DB → target DB
        const sourcePublishedId =
          (record as any).publishedId ||
          (record.transformedData as any)?.publishedId;

        let mediaCounts = {
          galleryCopied: 0,
          menuCopied: 0,
          reviewsCopied: 0,
        };

        if (sourcePublishedId) {
          mediaCounts = await this.migrateBusinessMedia({
            sourceBusinessId: String(sourcePublishedId),
            targetBusinessId: publishedBusinessId,
            sourceEnvironment: sourceSession.environment,
            targetEnvironment,
          });

          totalGalleryCopied += mediaCounts.galleryCopied;
          totalMenuCopied += mediaCounts.menuCopied;
          totalReviewsCopied += mediaCounts.reviewsCopied;
        }

        // Patch outlet with staging outlet data
        if (sourcePublishedId) {
          try {
            const patchSourceUri = this.resolveTargetUri(
              sourceSession.environment,
            );
            const patchSourceConn = await mongoose
              .createConnection(patchSourceUri).asPromise();
            const patchTargetUri = this.resolveTargetUri(
              targetEnvironment,
            );
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
                  sourcePublishedId,
                ),
              }).lean() as any;

              if (srcOutlet) {
                const tgtBusinessOid = new mongoose.Types.ObjectId(
                  publishedBusinessId,
                );

                // Find the target outlet created by post-publish
                const tgtOutlet = await TgtOutlet.findOne({
                  business: tgtBusinessOid,
                }).lean() as any;

                if (tgtOutlet) {
                  // Update with staging outlet fields; convert state to
                  // the canonical full name at the write boundary.
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
            `Migrated: ${record.transformedData?.name} ` +
            `→ ${targetEnvironment} ` +
            `(${mediaCounts.galleryCopied} gallery, ` +
            `${mediaCounts.menuCopied} menu, ` +
            `${mediaCounts.reviewsCopied} reviews)`,
        });

        migratedCount++;
      } catch (err: any) {
        failedCount++;
        this.logger.error(
          `Migration failed for record ${record._id}: ${err.message}`,
        );
        await this.logService.log({
          sessionId: migrationSessionId,
          action: SeedingLogActions.MIGRATION_FAILED,
          actor,
          message:
            `Failed: ${record.transformedData?.name} — ${err.message}`,
        });
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
