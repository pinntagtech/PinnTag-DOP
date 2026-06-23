import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import mongoose from 'mongoose';
import { SeedingSessionService } from './seeding-session.service';
import { SeedingRecordService } from './seeding-record.service';
import { SeedingLogService } from './seeding-log.service';
import { SeedingRecordDocument } from './schemas/seeding-record.schema';
import {
  SeedingSessionStatus,
  SeedingRecordStatus,
  SeedingLogActions,
  SeedingLogMessages,
  SeedingModules,
  ValidationSeverity,
  EnvironmentUriKey,
  SeedingErrorMessages,
  SeedingDefaults,
} from '../../common/constants';
import { Exceptions } from '../../common/errors';
import { ValidationEngine } from './engines/validation.engine';
import { TransformationEngine } from './engines/transformation.engine';
import { EnrichmentEngine } from './engines/enrichment.engine';
import { PostPublishService } from './activation/post-publish.service';
import { fullStateName } from './common/us-states';
import { computeDominant } from './common/dominant';

const MODULE_COLLECTION_MAP: Record<string, string> = {
  [SeedingModules.BUSINESS]: 'businesses',
  [SeedingModules.OUTLET]: 'outlets',
  [SeedingModules.EVENT]: 'events',
  [SeedingModules.EVENT_LOCATION]: 'eventlocations',
  [SeedingModules.EVENT_SCHEDULE]: 'eventschedules',
  [SeedingModules.MENU]: 'menus',
  [SeedingModules.MEDIA]: 'media',
};

@Injectable()
export class SeedingPipelineService {
  private readonly logger = new Logger(SeedingPipelineService.name);
  private readonly validationEngine = new ValidationEngine();
  private readonly transformationEngine = new TransformationEngine();

  constructor(
    private readonly sessionService: SeedingSessionService,
    private readonly recordService: SeedingRecordService,
    private readonly logService: SeedingLogService,
    private readonly configService: ConfigService,
    private readonly postPublishService: PostPublishService,
  ) {}

  // ── Validation ──────────────────────────────────────────────────────────────

  async runValidation(sessionId: string, actor: string): Promise<void> {
    await this.sessionService.findById(sessionId);
    await this.sessionService.updateStatus(
      sessionId,
      SeedingSessionStatus.VALIDATING,
      actor,
    );

    const records = await this.recordService.findBySession(sessionId, {
      status: SeedingRecordStatus.RAW,
    });

    for (const record of records) {
      const errors = this.validationEngine.validate(
        record.module,
        record.rawData,
      );
      await this.recordService.setValidationErrors(String(record._id), errors);

      const hasErrors = errors.some(
        (e) => e.severity === ValidationSeverity.ERROR,
      );

      if (hasErrors) {
        await this.recordService.updateStatus(
          String(record._id),
          SeedingRecordStatus.FAILED,
        );
        await this.logService.log({
          sessionId,
          recordId: String(record._id),
          action: SeedingLogActions.VALIDATION_FAILED,
          actor,
          fromStatus: SeedingRecordStatus.RAW,
          toStatus: SeedingRecordStatus.FAILED,
          message: SeedingLogMessages.validationFailed(
            String(record._id),
            errors.filter((e) => e.severity === ValidationSeverity.ERROR)
              .length,
          ),
        });
      } else {
        await this.recordService.updateStatus(
          String(record._id),
          SeedingRecordStatus.VALIDATED,
        );
        await this.logService.log({
          sessionId,
          recordId: String(record._id),
          action: SeedingLogActions.VALIDATED,
          actor,
          fromStatus: SeedingRecordStatus.RAW,
          toStatus: SeedingRecordStatus.VALIDATED,
          message: SeedingLogMessages.validationPassed(String(record._id)),
        });
      }
    }

    await this.sessionService.updateStats(sessionId);

    const remaining = await this.recordService.findBySession(sessionId, {
      status: SeedingRecordStatus.RAW,
    });
    if (remaining.length === 0) {
      await this.sessionService.updateStatus(
        sessionId,
        SeedingSessionStatus.VALIDATED,
        actor,
      );
    }
  }

  // ── Transformation ──────────────────────────────────────────────────────────

  async runTransformation(sessionId: string, actor: string): Promise<void> {
    await this.sessionService.updateStatus(
      sessionId,
      SeedingSessionStatus.TRANSFORMING,
      actor,
    );

    const records = await this.recordService.findBySession(sessionId, {
      status: SeedingRecordStatus.VALIDATED,
    });

    for (const record of records) {
      const transformed = this.transformationEngine.transform(
        record.module,
        record.rawData,
      );
      await this.recordService.setTransformedData(
        String(record._id),
        transformed,
      );
      await this.recordService.updateStatus(
        String(record._id),
        SeedingRecordStatus.TRANSFORMED,
      );
      await this.logService.log({
        sessionId,
        recordId: String(record._id),
        action: SeedingLogActions.TRANSFORMED,
        actor,
        fromStatus: SeedingRecordStatus.VALIDATED,
        toStatus: SeedingRecordStatus.TRANSFORMED,
        message: SeedingLogMessages.transformationComplete(String(record._id)),
      });
    }

    await this.sessionService.updateStats(sessionId);
    await this.sessionService.updateStatus(
      sessionId,
      SeedingSessionStatus.TRANSFORMED,
      actor,
    );
  }

  // ── Enrichment ──────────────────────────────────────────────────────────────

  async runEnrichment(sessionId: string, actor: string): Promise<void> {
    const session = await this.sessionService.findById(sessionId);
    await this.sessionService.updateStatus(
      sessionId,
      SeedingSessionStatus.ENRICHING,
      actor,
    );

    const targetUri = this.resolveTargetUri(session.environment);
    const targetConn = mongoose.createConnection(targetUri);
    const enrichmentEngine = new EnrichmentEngine(
      targetConn,
      this.configService.get<string>('app.pinntagApiUrl') ?? '',
      this.configService.get<string>('app.pinntagApiToken') ?? '',
      this.configService.get<string>('app.pinntagBusinessUserEmail') ?? '',
    );

    try {
      const records = await this.recordService.findBySessionWithFullData(
        sessionId,
        { status: SeedingRecordStatus.TRANSFORMED },
      );

      for (const record of records) {
        const { data, warnings } = await enrichmentEngine.enrich(
          record.module,
          record.transformedData ?? record.rawData,
        );

        if (warnings.length > 0) {
          await this.recordService.setValidationErrors(
            String(record._id),
            warnings,
          );
        }

        const hasErrors = warnings.some(
          (w) => w.severity === ValidationSeverity.ERROR,
        );

        if (hasErrors) {
          await this.recordService.updateStatus(
            String(record._id),
            SeedingRecordStatus.FAILED,
          );
          await this.logService.log({
            sessionId,
            recordId: String(record._id),
            action: SeedingLogActions.ENRICHMENT_FAILED,
            actor,
            fromStatus: SeedingRecordStatus.TRANSFORMED,
            toStatus: SeedingRecordStatus.FAILED,
            message: SeedingLogMessages.validationFailed(
              String(record._id),
              warnings.filter((w) => w.severity === ValidationSeverity.ERROR)
                .length,
            ),
          });
        } else {
          await this.recordService.setTransformedData(String(record._id), data);
          await this.recordService.updateStatus(
            String(record._id),
            SeedingRecordStatus.ENRICHED,
          );
          await this.logService.log({
            sessionId,
            recordId: String(record._id),
            action: SeedingLogActions.ENRICHED,
            actor,
            fromStatus: SeedingRecordStatus.TRANSFORMED,
            toStatus: SeedingRecordStatus.ENRICHED,
            message: SeedingLogMessages.enrichmentComplete(String(record._id)),
          });

          // Google enrichment detail log for business records
          if (record.module === SeedingModules.BUSINESS) {
            await this.logService.log({
              sessionId,
              recordId: String(record._id),
              action: SeedingLogActions.ENRICHED,
              actor,
              message:
                `Google enrichment: placeId=${data.placeId ?? 'none'}, ` +
                `rating=${data.rating ?? 'none'}, ` +
                `regularTiming=${data.regularTiming ? 'yes' : 'no'}, ` +
                `authorisedUser=${data.authorisedUser ? 'resolved' : 'not found'}`,
            });
          }
        }
      }

      await this.sessionService.updateStats(sessionId);
      await this.sessionService.updateStatus(
        sessionId,
        SeedingSessionStatus.ENRICHED,
        actor,
      );
    } finally {
      await targetConn.close();
    }
  }

  // ── Re-Enrichment ───────────────────────────────────────────────────────────

  async reEnrich(
    sessionId: string,
    recordIds: string[],
    actor: string,
  ): Promise<{ reEnriched: number; failed: number }> {
    const session = await this.sessionService.findById(sessionId);

    // If no recordIds provided, re-enrich all enriched records
    let targetIds = recordIds;
    if (!targetIds || targetIds.length === 0) {
      const enrichedRecords = await this.recordService.findBySessionWithFullData(
        sessionId,
        { status: SeedingRecordStatus.ENRICHED },
      );
      targetIds = enrichedRecords.map((r) => String(r._id));
    }

    if (targetIds.length === 0) {
      return { reEnriched: 0, failed: 0 };
    }

    // Reset records back to transformed
    await this.recordService.resetToTransformed(targetIds);

    const targetUri = this.resolveTargetUri(session.environment);
    const targetConn = mongoose.createConnection(targetUri);
    const enrichmentEngine = new EnrichmentEngine(
      targetConn,
      this.configService.get<string>('app.pinntagApiUrl') ?? '',
      this.configService.get<string>('app.pinntagApiToken') ?? '',
      this.configService.get<string>('app.pinntagBusinessUserEmail') ?? '',
    );

    let reEnriched = 0;
    let failedCount = 0;

    try {
      const records = await this.recordService.findByIds(targetIds);

      for (const record of records) {
        const { data, warnings } = await enrichmentEngine.enrich(
          record.module,
          record.transformedData ?? record.rawData,
        );

        if (warnings.length > 0) {
          await this.recordService.setValidationErrors(
            String(record._id),
            warnings,
          );
        }

        const hasErrors = warnings.some(
          (w) => w.severity === ValidationSeverity.ERROR,
        );

        if (hasErrors) {
          failedCount++;
          await this.recordService.updateStatus(
            String(record._id),
            SeedingRecordStatus.FAILED,
          );
          await this.logService.log({
            sessionId,
            recordId: String(record._id),
            action: SeedingLogActions.ENRICHMENT_FAILED,
            actor,
            fromStatus: SeedingRecordStatus.TRANSFORMED,
            toStatus: SeedingRecordStatus.FAILED,
            message: `Re-enrichment failed for record ${String(record._id).slice(-8)}`,
          });
        } else {
          reEnriched++;
          await this.recordService.setTransformedData(String(record._id), data);
          await this.recordService.updateStatus(
            String(record._id),
            SeedingRecordStatus.ENRICHED,
          );
          await this.logService.log({
            sessionId,
            recordId: String(record._id),
            action: SeedingLogActions.ENRICHED,
            actor,
            fromStatus: SeedingRecordStatus.TRANSFORMED,
            toStatus: SeedingRecordStatus.ENRICHED,
            message: `Re-enrichment complete for record ${String(record._id).slice(-8)}`,
          });
        }
      }

      await this.sessionService.updateStats(sessionId);
    } finally {
      await targetConn.close();
    }

    return { reEnriched, failed: failedCount };
  }

  // ── Approve ─────────────────────────────────────────────────────────────────

  async approveForPublishing(sessionId: string, actor: string): Promise<void> {
    const session = await this.sessionService.findById(sessionId);
    if (session.status !== SeedingSessionStatus.ENRICHED) {
      throw Exceptions.sessionNotReady(
        session.status,
        SeedingSessionStatus.ENRICHED,
      );
    }

    await this.recordService.bulkUpdateStatus(
      sessionId,
      SeedingRecordStatus.ENRICHED,
      SeedingRecordStatus.READY,
    );
    await this.sessionService.updateStats(sessionId);
    await this.sessionService.updateStatus(
      sessionId,
      SeedingSessionStatus.READY,
      actor,
    );

    await this.logService.log({
      sessionId,
      action: SeedingLogActions.APPROVED,
      actor,
      fromStatus: SeedingSessionStatus.ENRICHED,
      toStatus: SeedingSessionStatus.READY,
      message: SeedingLogMessages.sessionApproved(sessionId, actor),
    });
  }

  // ── Publish ─────────────────────────────────────────────────────────────────

  async publish(sessionId: string, actor: string): Promise<void> {
    const session = await this.sessionService.findById(sessionId);
    if (session.status !== SeedingSessionStatus.READY) {
      throw Exceptions.sessionNotReady(
        session.status,
        SeedingSessionStatus.READY,
      );
    }

    const targetUri = this.resolveTargetUri(session.environment);

    await this.sessionService.updateStatus(
      sessionId,
      SeedingSessionStatus.PUBLISHING,
      actor,
    );

    const targetConnection = mongoose.createConnection(targetUri);

    try {
      const records = await this.recordService.findBySession(sessionId, {
        status: SeedingRecordStatus.READY,
      });

      let failedCount = 0;

      for (const record of records) {
        try {
          const collectionName = MODULE_COLLECTION_MAP[record.module];
          if (!collectionName) {
            throw new Error(
              `No collection mapping for module "${record.module}"`,
            );
          }

          // Pre-publish duplicate check against target DB
          const dupCheck = await this.checkPublishDuplicate(
            record.transformedData,
            record.module,
            targetConnection,
          );
          if (dupCheck.blocked) {
            failedCount++;
            await this.recordService.updateStatus(
              String(record._id),
              SeedingRecordStatus.FAILED,
            );
            await this.recordService.setFailureReason(
              String(record._id),
              dupCheck.reason!,
            );
            await this.logService.log({
              sessionId,
              recordId: String(record._id),
              action: SeedingLogActions.PUBLISH_FAILED,
              actor,
              fromStatus: SeedingRecordStatus.READY,
              toStatus: SeedingRecordStatus.FAILED,
              message: dupCheck.reason!,
            });
            continue;
          }

          // Shallow-clone so we don't mutate the stored DOP record.
          // Convert state -> full name; stamp createdAt/updatedAt because
          // this is a raw driver insert (no schema-level timestamps apply).
          const now = new Date();
          const docToInsert: Record<string, any> = {
            ...(record.transformedData as any),
          };
          if (docToInsert.state) {
            docToInsert.state = fullStateName(docToInsert.state);
          }
          docToInsert.createdAt = now;
          docToInsert.updatedAt = now;

          const collection = targetConnection.collection(collectionName);
          const result = await collection.insertOne(docToInsert);
          const publishedId = String(result.insertedId);

          await this.recordService.markPublished(
            String(record._id),
            publishedId,
          );
          await this.logService.log({
            sessionId,
            recordId: String(record._id),
            action: SeedingLogActions.PUBLISHED,
            actor,
            fromStatus: SeedingRecordStatus.READY,
            toStatus: SeedingRecordStatus.PUBLISHED,
            message: SeedingLogMessages.publishSuccess(
              String(record._id),
              record.module,
            ),
          });
        } catch (err) {
          failedCount++;
          const errMessage =
            err instanceof Error ? err.message : 'Unknown publish error';
          await this.recordService.updateStatus(
            String(record._id),
            SeedingRecordStatus.FAILED,
          );
          await this.recordService.setFailureReason(
            String(record._id),
            errMessage,
          );
          await this.logService.log({
            sessionId,
            recordId: String(record._id),
            action: SeedingLogActions.PUBLISH_FAILED,
            actor,
            fromStatus: SeedingRecordStatus.READY,
            toStatus: SeedingRecordStatus.FAILED,
            message: SeedingLogMessages.publishFailed(
              String(record._id),
              errMessage,
            ),
          });
          this.logger.error(
            SeedingLogMessages.publishFailed(String(record._id), errMessage),
          );
        }
      }

      // Batched post-publish activation — reuses targetConnection
      // to avoid one mongoose connection per record.
      const businessRecordsToActivate = await this.recordService.findBySession(
        sessionId,
        { status: SeedingRecordStatus.PUBLISHED },
      );
      const toActivate = businessRecordsToActivate.filter(
        (r) => r.module === SeedingModules.BUSINESS && r.publishedId,
      );

      const BATCH_SIZE = 5;
      for (let i = 0; i < toActivate.length; i += BATCH_SIZE) {
        const batch = toActivate.slice(i, i + BATCH_SIZE);

        await Promise.all(
          batch.map(async (record) => {
            const result = await this.postPublishService.activateBusiness({
              businessId: record.publishedId!,
              environment: session.environment,
              sessionId,
              sharedConnection: targetConnection,
            });
            await this.logService.log({
              sessionId,
              action: result.success
                ? SeedingLogActions.ENRICHED
                : SeedingLogActions.ENRICHMENT_FAILED,
              actor,
              message: result.message,
              metadata: result.details,
            });
          }),
        );

        this.logger.log(
          `[PUBLISH] Batch ${Math.floor(i / BATCH_SIZE) + 1}` +
            `/${Math.ceil(toActivate.length / BATCH_SIZE)} done ` +
            `(${Math.min(i + BATCH_SIZE, toActivate.length)}/${toActivate.length})`,
        );
      }

      await this.sessionService.updateStats(sessionId);

      // Refresh dominant city/state/industry/category from the session's
      // records — by publish-time, resolvers have written authoritative
      // city/state, so this is more accurate than the import-time snapshot.
      const allRecords = await this.recordService.findBySession(sessionId);
      const dominant = computeDominant(
        allRecords.map((r) => ({
          rawData: r.rawData,
          transformedData: r.transformedData,
        })),
      );
      await this.sessionService.updateById(sessionId, {
        dominantCity: dominant.dominantCity,
        dominantState: dominant.dominantState,
        dominantIndustry: dominant.dominantIndustry,
        dominantCategory: dominant.dominantCategory,
      });

      // Session-level status reflects the action taken (we ran publish),
      // not the aggregate per-record outcome. Individual records that
      // failed keep their per-record FAILED status and per-record
      // PUBLISH_FAILED log entries — those stay honest. Only the session
      // aggregate is always PUBLISHED once the publish loop completes.
      const s = await this.sessionService.findById(sessionId);
      s.status = SeedingSessionStatus.PUBLISHED;
      s.publishedAt = new Date();
      s.publishedBy = actor;
      if (failedCount > 0) {
        // Informational only — does NOT change the session status.
        s.errorSummary =
          `Published with ${failedCount} record(s) needing attention`;
      } else {
        (s as any).errorSummary = undefined;
      }
      await s.save();

      await this.logService.log({
        sessionId,
        action: SeedingLogActions.PUBLISHED,
        actor,
        toStatus: SeedingSessionStatus.PUBLISHED,
        message:
          failedCount > 0
            ? `Publishing completed — ${failedCount} record(s) need attention`
            : SeedingLogMessages.sessionPublished(
                sessionId,
                session.environment,
              ),
      });
    } finally {
      await targetConnection.close();
    }
  }

  // ── Seed References ─────────────────────────────────────────────────────────

  async seedReferenceData(environment: string): Promise<any> {
    const uriKey =
      EnvironmentUriKey[environment as keyof typeof EnvironmentUriKey];
    const targetUri = this.configService.get<string>(uriKey);
    console.log(
      `Seeding reference data for environment "${environment}" using URI: ${targetUri}`,
    );
    if (!targetUri) throw Exceptions.publishTargetMissing(environment);

    const conn = await mongoose.createConnection(targetUri).asPromise();
    console.log(
      'Connected to target database for seeding references',
      conn.name,
    );
    const BusinessUserModel =
      conn.models['BusinessUser'] ||
      conn.model('BusinessUser', new mongoose.Schema({}, { strict: false }));

    const email = this.configService.get<string>(
      'app.pinntagBusinessUserEmail',
    );

    const existing = await BusinessUserModel.findOne({ email });

    if (!existing) {
      await BusinessUserModel.create({
        email,
        name: 'PinnTag System',
        isActive: true,
        isDeleted: false,
        status: 0,
        creatorType: 'Admin',
        isEmailVerified: true,
        isMobileVerified: false,
        appleLoggedIn: false,
        googleLoggedIn: false,
        forcePasswordReset: false,
        webWalkThroughCompleted: false,
        appWalkThroughCompleted: false,
        business: [],
        assignedOutlets: [],
      });
    }

    await conn.close();

    return {
      success: true,
      message: `Reference data seeded for ${environment}`,
      email,
    };
  }

  // ── Pre-publish duplicate check ──────────────────────────────────────────────

  private async checkPublishDuplicate(
    data: any,
    module: string,
    conn: mongoose.Connection,
  ): Promise<{ blocked: boolean; reason?: string }> {
    if (module !== SeedingModules.BUSINESS) {
      return { blocked: false };
    }

    // Block only on placeId — Google's globally-unique location id.
    // Same-name records (chain locations) must fall through so that
    // PostPublishService.activateBusiness can run its multi-location
    // detection and attach a second outlet to the existing parent.
    if (!data?.placeId) return { blocked: false };

    const BusinessModel =
      conn.models['Business'] ||
      conn.model(
        'Business',
        new mongoose.Schema({}, { strict: false }),
      );

    const existing = (await BusinessModel.findOne({ placeId: data.placeId })
      .select('placeId')
      .lean()) as any;

    if (!existing) return { blocked: false };

    return {
      blocked: true,
      reason: `Business already published with placeId: ${data.placeId}`,
    };
  }

  // ── Admin: Reset & Delete ────────────────────────────────────────────────────

  private verifyAdminPassword(password: string): void {
    const expected = this.configService.get<string>('app.dopAdminPassword');
    if (!expected || password !== expected) {
      throw Exceptions.invalidAdminPassword();
    }
  }

  async resetSession(
    sessionId: string,
    actor: string,
    adminPassword: string,
  ): Promise<void> {
    this.verifyAdminPassword(adminPassword);

    const session = await this.sessionService.findById(sessionId);
    const targetUri = this.resolveTargetUri(session.environment);
    const targetConn = mongoose.createConnection(targetUri);

    try {
      const publishedRecords = await this.recordService.findBySession(
        sessionId,
        { status: SeedingRecordStatus.PUBLISHED },
      );

      for (const record of publishedRecords) {
        if (record.publishedId) {
          const collectionName = MODULE_COLLECTION_MAP[record.module];
          if (collectionName) {
            const publishedOid = new mongoose.Types.ObjectId(
              record.publishedId,
            );

            if (record.module === SeedingModules.BUSINESS) {
              // Bot-scraped data cleanup
              const ReviewModel = targetConn.model(
                'Review',
                new mongoose.Schema({}, { strict: false }),
                'reviews',
              );
              const MenuModel = targetConn.model(
                'Menu',
                new mongoose.Schema({}, { strict: false }),
                'menus',
              );
              const FileModel = targetConn.model(
                'File',
                new mongoose.Schema({}, { strict: false }),
                'files',
              );
              const FolderModel = targetConn.model(
                'Folder',
                new mongoose.Schema({}, { strict: false }),
                'folders',
              );
              const DriveModel = targetConn.model(
                'Drive',
                new mongoose.Schema({}, { strict: false }),
                'drives',
              );

              const businessDriveIds = await DriveModel
                .find({
                  owner: new mongoose.Types.ObjectId(record.publishedId),
                })
                .distinct('_id');

              await Promise.all([
                targetConn
                  .collection('outlets')
                  .deleteMany({ business: publishedOid }),
                targetConn
                  .collection('events')
                  .deleteMany({ businessProfile: publishedOid }),
                targetConn
                  .collection('eventlocations')
                  .deleteMany({ businessProfile: publishedOid }),
                targetConn
                  .collection('eventschedules')
                  .deleteMany({ businessId: publishedOid }),
                targetConn
                  .collection('follows')
                  .deleteMany({ following: publishedOid }),
                targetConn
                  .collection('feeds')
                  .deleteMany({ creator: publishedOid }),
                targetConn
                  .collection('drives')
                  .deleteMany({ owner: publishedOid }),
                targetConn
                  .collection('folders')
                  .deleteMany({ owner: publishedOid }),
                targetConn
                  .collection('subscriptions')
                  .deleteMany({ business: publishedOid }),
                targetConn
                  .collection('creditwallets')
                  .deleteMany({ business: publishedOid }),
                ReviewModel.deleteMany({
                  business: new mongoose.Types.ObjectId(record.publishedId),
                }),
                MenuModel.deleteMany({
                  business: new mongoose.Types.ObjectId(record.publishedId),
                }),
                FileModel.deleteMany({
                  parent: new mongoose.Types.ObjectId(record.publishedId),
                }),
                // Delete gallery subfolders (not the main Gallery folder
                // which is deleted with the drive, but the bot-created
                // subfolders inside it)
                FolderModel.deleteMany({
                  $and: [
                    { drive: { $exists: true } },
                    {
                      folderName: {
                        $nin: ['Gallery', 'Drive'],
                      },
                    },
                    { drive: { $in: businessDriveIds } },
                  ],
                }),
              ]);

              this.logger.log(
                `Cascade deleted bot data for business ${record.publishedId}: ` +
                  `reviews, menus, files, gallery subfolders, credit wallet`,
              );
            }

            await targetConn
              .collection(collectionName)
              .deleteOne({ _id: publishedOid });
          }

          await this.logService.log({
            sessionId,
            recordId: String(record._id),
            action: SeedingLogActions.RECORD_DELETED_FROM_TARGET,
            actor,
            message: SeedingLogMessages.recordDeletedFromTarget(
              record.publishedId,
              record.module,
            ),
          });
        }
      }
    } finally {
      await targetConn.close();
    }

    await this.recordService.resetAllRecords(sessionId);

    session.status = SeedingSessionStatus.DRAFT;
    (session as any).publishedAt = undefined;
    (session as any).publishedBy = undefined;
    (session as any).errorSummary = undefined;
    session.stats = SeedingDefaults.STATS;
    session.totalRecords = session.totalRecords; // preserve count
    await session.save();

    await this.sessionService.updateStats(sessionId);

    await this.logService.log({
      sessionId,
      action: SeedingLogActions.SESSION_RESET,
      actor,
      toStatus: SeedingSessionStatus.DRAFT,
      message: SeedingLogMessages.sessionReset(sessionId, actor),
    });
  }

  async deleteSession(
    sessionId: string,
    actor: string,
    adminPassword: string,
  ): Promise<void> {
    this.verifyAdminPassword(adminPassword);

    await this.resetSession(sessionId, actor, adminPassword);

    await this.logService.deleteSessionLogs(sessionId);
    await this.recordService.deleteAllRecords(sessionId);
    await this.sessionService.delete(sessionId);
  }

  async resetBotStages(
    sessionId: string,
    stages: ('gallery' | 'menu' | 'reviews')[],
    environment: string,
  ): Promise<void> {
    const session = await this.sessionService.findById(sessionId);
    const targetUri = this.resolveTargetUri(
      environment || session.environment,
    );
    const conn = await mongoose
      .createConnection(targetUri)
      .asPromise();

    try {
      // Get all published records for this session
      const records = await this.recordService.findBySession(
        sessionId,
        { status: SeedingRecordStatus.PUBLISHED },
      );

      for (const record of records) {
        if (!record.publishedId) continue;
        const businessOid = new mongoose.Types.ObjectId(
          record.publishedId,
        );

        const ReviewModel = conn.model(
          'Review',
          new mongoose.Schema({}, { strict: false }),
          'reviews',
        );
        const MenuModel = conn.model(
          'Menu',
          new mongoose.Schema({}, { strict: false }),
          'menus',
        );
        const FileModel = conn.model(
          'File',
          new mongoose.Schema({}, { strict: false }),
          'files',
        );
        const FolderModel = conn.model(
          'Folder',
          new mongoose.Schema({}, { strict: false }),
          'folders',
        );
        const DriveModel = conn.model(
          'Drive',
          new mongoose.Schema({}, { strict: false }),
          'drives',
        );
        const BusinessModel = conn.model(
          'Business',
          new mongoose.Schema({}, { strict: false }),
          'businesses',
        );

        if (stages.includes('reviews')) {
          await ReviewModel.deleteMany({
            business: businessOid,
          });
          this.logger.log(
            `[RESET] Reviews deleted for ${record.publishedId}`,
          );
        }

        if (stages.includes('menu')) {
          // Get menu ids first to remove from business
          const menus = (await MenuModel.find({
            business: businessOid,
          })
            .select('_id')
            .lean()) as any[];

          await MenuModel.deleteMany({ business: businessOid });

          // Remove menu refs from business
          if (menus.length > 0) {
            await BusinessModel.updateOne(
              { _id: businessOid },
              {
                $pull: {
                  menus: { $in: menus.map((m: any) => m._id) },
                },
              },
            );
          }

          // Delete menu image files
          await FileModel.deleteMany({
            parent: businessOid,
            'metaData.originalName': /^menu-/,
          });

          this.logger.log(
            `[RESET] Menu deleted for ${record.publishedId}`,
          );
        }

        if (stages.includes('gallery')) {
          // Get the drive for this business
          const drive = (await DriveModel.findOne({
            owner: businessOid,
          }).lean()) as any;

          if (drive) {
            // Find and delete gallery subfolders
            // (not the main Gallery folder)
            const galleryFolder = (await FolderModel.findOne({
              folderName: 'Gallery',
              drive: drive._id,
            }).lean()) as any;

            if (galleryFolder) {
              // Delete subfolders inside Gallery
              const subFolders = (await FolderModel.find({
                parentDirectory: galleryFolder._id,
              })
                .select('_id')
                .lean()) as any[];

              // Delete files in each subfolder
              for (const sf of subFolders) {
                await FileModel.deleteMany({
                  parentDirectory: sf._id,
                });
              }

              // Delete the subfolders themselves
              await FolderModel.deleteMany({
                parentDirectory: galleryFolder._id,
              });
            }
          }

          this.logger.log(
            `[RESET] Gallery deleted for ${record.publishedId}`,
          );
        }

        // Reset botScrape progress on DOP record
        await this.recordService.resetBotData(
          record.publishedId,
          stages,
        );
      }
    } finally {
      await conn.close();
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private resolveTargetUri(environment: string): string {
    const uriKey =
      EnvironmentUriKey[environment as keyof typeof EnvironmentUriKey];
    const uri = this.configService.get<string>(uriKey);
    if (!uri) {
      throw Exceptions.publishTargetMissing(environment);
    }
    return uri;
  }

}
