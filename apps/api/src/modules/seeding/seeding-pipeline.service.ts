import { HttpException, Injectable, Logger } from '@nestjs/common';
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
import { SEED_DEFAULT_COVER } from './activation/seed-defaults';
import { buildSeededFilter } from './common/seeded-cohort';

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
    dryRun = false,
  ): Promise<void> {
    this.verifyAdminPassword(adminPassword);

    const session = await this.sessionService.findById(sessionId);
    const targetUri = this.resolveTargetUri(session.environment);
    const targetConn = await mongoose.createConnection(targetUri).asPromise();

    try {
      const publishedRecords = await this.recordService.findBySession(
        sessionId,
        { status: SeedingRecordStatus.PUBLISHED },
      );

      const businessOids: mongoose.Types.ObjectId[] = [];
      const nonBusinessPublished: typeof publishedRecords = [];
      for (const record of publishedRecords) {
        if (!record.publishedId) continue;
        if (record.module === SeedingModules.BUSINESS) {
          businessOids.push(new mongoose.Types.ObjectId(record.publishedId));
        } else {
          nonBusinessPublished.push(record);
        }
      }

      if (businessOids.length) {
        await this.purgeBusinessData(targetConn, businessOids, { dryRun });
      }

      for (const record of nonBusinessPublished) {
        const collectionName = MODULE_COLLECTION_MAP[record.module];
        if (collectionName && !dryRun) {
          const publishedOid = new mongoose.Types.ObjectId(record.publishedId);
          await targetConn
            .collection(collectionName)
            .deleteOne({ _id: publishedOid });
        }
      }

      if (!dryRun) {
        for (const record of publishedRecords) {
          if (!record.publishedId) continue;
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

    if (dryRun) return;

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

    await this.resetSession(sessionId, actor, adminPassword, false);

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

  // ── Admin: Dedup businesses by placeId ───────────────────────────────────
  //
  // Historical duplicates in the seeded corpus (isCvb || isFromCrawler) that
  // share a placeId cause the gated-migration `singleton_placeId` gate to
  // exclude ALL copies. This method finds each duplicate group, picks a
  // canonical using the same priority the eligibility gate rewards (real B2
  // cover → resolved hours → taxonomy → active outlet → oldest), and cascade-
  // deletes the losers via purgeBusinessData. The purge helper already
  // enforces the claimed/Stripe-backed safety guard; if it throws for a
  // group, that group is recorded as `flaggedForReview` (no delete) and the
  // batch continues.
  //
  // Environment is locked to `staging` — the task fixes only pinntagStaging.
  // The payoff (more prod-eligible businesses) surfaces automatically the
  // next time the gated-migration preview is re-run against pre-prod.
  private static readonly DEDUP_MEDIA_STAGING_RE =
    /media-staging\.pinntag\.com/i;
  private static readonly DEDUP_GOOGLE_HOST_RE = /googleusercontent/i;

  async dedupBusinessesByPlaceId(opts: {
    environment: string;
    adminPassword: string;
    dryRun?: boolean;
    placeIds?: string[];
    limit?: number;
  }): Promise<{
    environment: string;
    dryRun: boolean;
    totals: {
      duplicateGroupsFound: number;
      groupsProcessed: number;
      losersDeleted: number;
      groupsFlaggedForReview: number;
    };
    perGroup: Array<{
      placeId: string;
      canonicalId: string;
      loserIds: string[];
      loserCount: number;
      purgeSummary?: Record<string, number>;
      flaggedReason?: string;
    }>;
  }> {
    this.verifyAdminPassword(opts.adminPassword);
    const dryRun = opts.dryRun !== false; // default dry
    const environment = opts.environment;
    if (environment !== 'staging') {
      throw new HttpException(
        'dedupBusinessesByPlaceId only runs against staging',
        400,
      );
    }

    const targetUri = this.resolveTargetUri(environment);
    const targetConn = await mongoose.createConnection(targetUri).asPromise();

    try {
      const businesses = targetConn.collection('businesses');

      // ── 1. Identify duplicate groups (seeded-only + non-empty placeId) ──
      // Cohort filter uses the shared buildSeededFilter so this pass sees
      // the union of legacy-flagged (isCvb/isFromCrawler) AND manual-seeder
      // (seedProvenance.isSeeded) businesses. The prior hardcoded $or
      // silently skipped the manual-seeder cohort.
      const match: Record<string, any> = {
        ...buildSeededFilter(),
        placeId: { $nin: [null, ''] },
      };
      if (opts.placeIds?.length) {
        match.placeId = { $in: opts.placeIds };
      }

      const groups = (await businesses
        .aggregate([
          { $match: match },
          {
            $group: {
              _id: '$placeId',
              ids: { $push: '$_id' },
              count: { $sum: 1 },
            },
          },
          { $match: { count: { $gt: 1 } } },
        ])
        .toArray()) as Array<{
        _id: string;
        ids: mongoose.Types.ObjectId[];
        count: number;
      }>;

      const duplicateGroupsFound = groups.length;
      const capped = opts.limit
        ? groups.slice(0, Math.max(0, opts.limit))
        : groups;

      // ── 2/3. Score & pick canonical, then attempt purge (or dry-run) ──
      const seenCanonicalIds = new Set<string>();
      const perGroup: Array<{
        placeId: string;
        canonicalId: string;
        loserIds: string[];
        loserCount: number;
        purgeSummary?: Record<string, number>;
        flaggedReason?: string;
      }> = [];

      let losersDeleted = 0;
      let groupsFlaggedForReview = 0;
      let groupsProcessed = 0;

      for (const group of capped) {
        const docs = (await businesses
          .find(
            { _id: { $in: group.ids } },
            {
              projection: {
                _id: 1,
                cover: 1,
                resolveStatus: 1,
                businessIndustry: 1,
                businessCategories: 1,
                activatedOutletsLength: 1,
                createdAt: 1,
                placeId: 1,
              },
            },
          )
          .toArray()) as any[];

        if (docs.length < 2) continue; // group changed under us

        const scored = docs.map((d) => ({
          id: d._id as mongoose.Types.ObjectId,
          createdAt:
            d.createdAt instanceof Date
              ? d.createdAt.getTime()
              : Number.MAX_SAFE_INTEGER,
          score: this.scoreDedupCandidate(d),
        }));

        // Highest score wins; tiebreak: oldest createdAt.
        scored.sort((a, b) =>
          b.score - a.score !== 0
            ? b.score - a.score
            : a.createdAt - b.createdAt,
        );

        const canonical = scored[0];
        const losers = scored.slice(1);
        const canonicalIdStr = String(canonical.id);
        const loserIdsStr = losers.map((l) => String(l.id));

        // Guard 3c: a loser id must not be a canonical for another group.
        // (Impossible with placeId grouping since each doc has one placeId,
        // but we assert for defense.)
        const collision = loserIdsStr.find((id) =>
          seenCanonicalIds.has(id),
        );
        if (collision) {
          perGroup.push({
            placeId: group._id,
            canonicalId: canonicalIdStr,
            loserIds: loserIdsStr,
            loserCount: loserIdsStr.length,
            flaggedReason: `loser ${collision} is also canonical for a prior group`,
          });
          groupsFlaggedForReview += 1;
          continue;
        }
        seenCanonicalIds.add(canonicalIdStr);

        try {
          const purgeSummary = await this.purgeBusinessData(
            targetConn,
            losers.map((l) => l.id),
            { dryRun },
          );
          perGroup.push({
            placeId: group._id,
            canonicalId: canonicalIdStr,
            loserIds: loserIdsStr,
            loserCount: loserIdsStr.length,
            purgeSummary,
          });
          groupsProcessed += 1;
          // purgeSummary.businesses is either the count (dry-run) or the
          // deletedCount (live). Both are meaningful for the total.
          losersDeleted += Math.max(0, purgeSummary.businesses ?? 0);
        } catch (err: any) {
          perGroup.push({
            placeId: group._id,
            canonicalId: canonicalIdStr,
            loserIds: loserIdsStr,
            loserCount: loserIdsStr.length,
            flaggedReason: err?.message ?? String(err),
          });
          groupsFlaggedForReview += 1;
        }
      }

      this.logger.log(
        `[DEDUP${dryRun ? '-DRYRUN' : ''}] env=${environment} ` +
          `groupsFound=${duplicateGroupsFound} processed=${groupsProcessed} ` +
          `losersDeleted=${losersDeleted} flagged=${groupsFlaggedForReview}`,
      );

      return {
        environment,
        dryRun,
        totals: {
          duplicateGroupsFound,
          groupsProcessed,
          losersDeleted,
          groupsFlaggedForReview,
        },
        perGroup,
      };
    } finally {
      await targetConn.close();
    }
  }

  // Higher score = more likely to be the useful copy. Weights are ordered
  // to match the eligibility gate's evaluation order (real_cover first,
  // real_hours next, taxonomy_present, active_outlet) — the canonical we
  // keep should be the one most likely to pass the gate on its own.
  private scoreDedupCandidate(doc: Record<string, any>): number {
    let score = 0;
    const cover = typeof doc.cover === 'string' ? doc.cover : '';
    const coverIsReal =
      !!cover &&
      cover !== SEED_DEFAULT_COVER &&
      !SeedingPipelineService.DEDUP_GOOGLE_HOST_RE.test(cover) &&
      SeedingPipelineService.DEDUP_MEDIA_STAGING_RE.test(cover);
    if (coverIsReal) score += 16;

    const rs = doc.resolveStatus;
    if (
      rs &&
      rs.hours === 'done' &&
      Array.isArray(rs.hoursRaw) &&
      rs.hoursRaw.length > 0
    ) {
      score += 8;
    }

    if (
      doc.businessIndustry &&
      Array.isArray(doc.businessCategories) &&
      doc.businessCategories.length > 0
    ) {
      score += 4;
    }

    if (
      typeof doc.activatedOutletsLength === 'number' &&
      doc.activatedOutletsLength >= 1
    ) {
      score += 2;
    }
    return score;
  }

  // ── Admin: Resync city from addressLine1 ─────────────────────────────────
  //
  // Seeded businesses (isCvb || isFromCrawler) where `city` has drifted from
  // the value implied by `addressLine1` — county names in place of borough,
  // township/village splits in NY, truncated multi-word names — get excluded
  // by the gated-migration `valid_address` gate. This method re-derives city
  // from the already-trusted `addressLine1`: strip trailing country, split
  // on commas, take the second-to-last segment (the one immediately before
  // the state/zip). Same derivation as parseAddress in scraper-adapter.ts,
  // applied to the stored address instead of a raw scrape.
  //
  // Only the `city` field is touched. Any record whose addressLine1 has
  // fewer than 2 segments after country stripping, or whose derived
  // candidate is empty or purely numeric, is skipped and surfaced as
  // `skippedAmbiguousSample` for operator review. Environment is locked to
  // `staging` — the task fixes only pinntagStaging.
  //
  // Same request body drives all three operator phases:
  //   dryRun:true                    → report scans, mismatches, samples
  //   dryRun:false + businessIds:[…] → apply on hand-picked sample only
  //   dryRun:false + limit:N (opt)   → apply, capped at N writes; loop until
  //                                    the response reports 0 corrected
  async resyncCityFromAddressLine1(opts: {
    environment: string;
    adminPassword: string;
    dryRun?: boolean;
    businessIds?: string[];
    limit?: number;
  }): Promise<{
    environment: string;
    dryRun: boolean;
    totals: {
      scanned: number;
      mismatchCount: number;
      corrected: number;
      skippedAmbiguous: number;
      // Categorical breakdown of the skippedAmbiguous total, so an
      // operator can see how many records the state+ZIP guard caught
      // vs. the earlier structural skips. Keys are stable tokens.
      skippedAmbiguousByReason: Record<string, number>;
    };
    // Top 10 states by mismatch count. Present because the initial
    // dry-run was heavy on Georgia/Atlanta, suggesting cohort-specific
    // addressLine1 formats. This makes concentration visible without
    // a separate query.
    stateDistribution: Array<{ state: string; count: number }>;
    mismatchSample: Array<{
      businessId: string;
      currentCity: string;
      derivedCity: string;
      addressLine1: string;
    }>;
    skippedAmbiguousSample: Array<{
      businessId: string;
      currentCity: string;
      addressLine1: string;
      reason: string;
    }>;
  }> {
    this.verifyAdminPassword(opts.adminPassword);
    const dryRun = opts.dryRun !== false; // default dry
    const environment = opts.environment;
    if (environment !== 'staging') {
      throw new HttpException(
        'resyncCityFromAddressLine1 only runs against staging',
        400,
      );
    }

    const targetUri = this.resolveTargetUri(environment);
    const targetConn = await mongoose.createConnection(targetUri).asPromise();

    try {
      const businesses = targetConn.collection('businesses');
      // Cohort filter uses the shared buildSeededFilter so this pass sees
      // the union of legacy-flagged AND manual-seeder businesses. The
      // prior hardcoded $or silently skipped the manual-seeder cohort.
      const match: Record<string, any> = {
        ...buildSeededFilter(),
        addressLine1: { $nin: [null, ''] },
        city: { $nin: [null, ''] },
      };
      if (opts.businessIds?.length) {
        match._id = {
          $in: opts.businessIds.map(
            (id) => new mongoose.Types.ObjectId(id),
          ),
        };
      }

      const cursor = businesses.find(match, {
        // `state` added so we can report top-10-by-mismatch. Nothing
        // else is projected — city is the only write target.
        projection: { _id: 1, addressLine1: 1, city: 1, state: 1 },
      });

      const SAMPLE_CAP = 30;
      const writeCap =
        opts.limit && opts.limit > 0
          ? opts.limit
          : Number.POSITIVE_INFINITY;

      let scanned = 0;
      let mismatchCount = 0;
      let corrected = 0;
      let skippedAmbiguous = 0;
      const skippedAmbiguousByReason: Record<string, number> = {};
      const mismatchByState = new Map<string, number>();
      const mismatchSample: Array<{
        businessId: string;
        currentCity: string;
        derivedCity: string;
        addressLine1: string;
      }> = [];
      const skippedAmbiguousSample: Array<{
        businessId: string;
        currentCity: string;
        addressLine1: string;
        reason: string;
      }> = [];

      while (await cursor.hasNext()) {
        if (!dryRun && corrected >= writeCap) break;
        const doc = (await cursor.next()) as any;
        if (!doc) break;
        scanned += 1;

        const addressLine1 = String(doc.addressLine1 || '');
        const currentCity = String(doc.city || '');
        const state = String(doc.state || '');
        const { derivedCity, ambiguousReason } =
          this.deriveCityFromAddressLine1(addressLine1);

        if (!derivedCity) {
          skippedAmbiguous += 1;
          const reasonKey = ambiguousReason ?? 'unknown';
          skippedAmbiguousByReason[reasonKey] =
            (skippedAmbiguousByReason[reasonKey] ?? 0) + 1;
          if (skippedAmbiguousSample.length < SAMPLE_CAP) {
            skippedAmbiguousSample.push({
              businessId: String(doc._id),
              currentCity,
              addressLine1,
              reason: reasonKey,
            });
          }
          continue;
        }

        // Case- and whitespace-insensitive equality: skip records that only
        // differ in casing/whitespace — nothing has actually drifted.
        if (
          derivedCity.trim().toLowerCase() ===
          currentCity.trim().toLowerCase()
        ) {
          continue;
        }

        mismatchCount += 1;
        const stateKey = state.trim() || '(unknown)';
        mismatchByState.set(
          stateKey,
          (mismatchByState.get(stateKey) ?? 0) + 1,
        );
        if (mismatchSample.length < SAMPLE_CAP) {
          mismatchSample.push({
            businessId: String(doc._id),
            currentCity,
            derivedCity,
            addressLine1,
          });
        }

        if (!dryRun) {
          await businesses.updateOne(
            { _id: doc._id },
            { $set: { city: derivedCity } },
          );
          corrected += 1;
        }
      }

      const stateDistribution = Array.from(mismatchByState.entries())
        .map(([state, count]) => ({ state, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10);

      this.logger.log(
        `[RESYNC-CITY${dryRun ? '-DRYRUN' : ''}] env=${environment} ` +
          `scanned=${scanned} mismatchCount=${mismatchCount} ` +
          `corrected=${corrected} skippedAmbiguous=${skippedAmbiguous} ` +
          `skippedByReason=${JSON.stringify(skippedAmbiguousByReason)}`,
      );

      return {
        environment,
        dryRun,
        totals: {
          scanned,
          mismatchCount,
          corrected,
          skippedAmbiguous,
          skippedAmbiguousByReason,
        },
        stateDistribution,
        mismatchSample,
        skippedAmbiguousSample,
      };
    } finally {
      await targetConn.close();
    }
  }

  // Re-derive city from the trusted addressLine1.
  //
  // Only derive when the address looks like a real US postal-format
  // string: after the trailing country segment is stripped, the FINAL
  // remaining segment must be a US state code + ZIP (e.g. "NY 10004" or
  // "NJ 07747-1234"). Only then is the second-to-last segment safe to
  // interpret as the city.
  //
  // Without this anchor, strings that happen to contain a comma but are
  // not postal addresses (e.g. "The Ritz-Carlton, Atlanta 181 Peachtree
  // Street Northwest") derive nonsense like a business name and would
  // overwrite the correct `city`. The dry-run that surfaced this bug
  // had roughly 10% of proposed corrections corrupting a good city with
  // a business name or service description; the state+ZIP guard rejects
  // those as `no_state_zip_segment`.
  //
  // Reason tokens are stable snake_case so the operator's counters
  // (`skippedAmbiguousByReason`) stay consistent across runs:
  //   - fewer_than_2_segments  : structural — comma missing or trailing
  //   - no_state_zip_segment   : NEW — the state+ZIP anchor is absent
  //   - empty_derived          : second-to-last segment blank
  //   - numeric_derived        : second-to-last segment is digits only
  //   - empty_addressLine1     : addressLine1 was empty/whitespace
  private static readonly STATE_ZIP_RE =
    /^[A-Za-z]{2}\s+\d{5}(-\d{4})?$/;

  private deriveCityFromAddressLine1(addressLine1: string): {
    derivedCity: string | null;
    ambiguousReason?: string;
  } {
    const raw = (addressLine1 ?? '').toString().trim();
    if (!raw) {
      return { derivedCity: null, ambiguousReason: 'empty_addressLine1' };
    }
    const withoutCountry = raw
      .replace(/,\s*(USA|United States(?: of America)?)\s*$/i, '')
      .trim();
    const parts = withoutCountry
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length < 2) {
      return {
        derivedCity: null,
        ambiguousReason: 'fewer_than_2_segments',
      };
    }

    // The postal-format anchor. If the final segment isn't "XX 12345"
    // (optionally "-1234"), the address is not a comma-delimited postal
    // string; the second-to-last segment is not safely a city.
    const lastSegment = parts[parts.length - 1];
    if (!SeedingPipelineService.STATE_ZIP_RE.test(lastSegment)) {
      return {
        derivedCity: null,
        ambiguousReason: 'no_state_zip_segment',
      };
    }

    const candidate = parts[parts.length - 2].trim();
    if (!candidate) {
      return {
        derivedCity: null,
        ambiguousReason: 'empty_derived',
      };
    }
    if (/^\d+$/.test(candidate)) {
      return {
        derivedCity: null,
        ambiguousReason: 'numeric_derived',
      };
    }
    return { derivedCity: candidate };
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  /**
   * Cascade-delete all data for the given target-DB business ids.
   * Scoped strictly to businessObjectIds — cannot affect other businesses.
   * Deviations from the main-app purgeBusinessData (intentional):
   *   - Stripe cancellation is NOT called; instead we REFUSE to run if any
   *     business is claimed or has a stripeSubscriptionId (DOP only deletes
   *     seeded/unclaimed businesses with free subscriptions).
   *   - Media (drives/folders/files) IS deleted here (main-app version omits
   *     it); DOP must clean the publish + bot-scrape media it created.
   *   - Files are deleted by drive/parentDirectory, not by `parent`
   *     (file.parent is a BusinessUser, not the business).
   */
  private async purgeBusinessData(
    targetConn: mongoose.Connection,
    businessObjectIds: mongoose.Types.ObjectId[],
    opts: { dryRun?: boolean } = {},
  ): Promise<Record<string, number>> {
    const dryRun = !!opts.dryRun;
    const ids = businessObjectIds;
    if (!ids.length) return {};

    // ── SAFETY GUARD: refuse claimed / Stripe-backed businesses ──
    const claimed = await targetConn
      .collection('businesses')
      .find(
        { _id: { $in: ids }, isClaimed: true },
        { projection: { _id: 1, name: 1 } },
      )
      .toArray();
    const stripeBacked = await targetConn
      .collection('subscriptions')
      .find(
        {
          business: { $in: ids },
          stripeSubscriptionId: { $exists: true, $nin: [null, ''] },
        },
        { projection: { business: 1, stripeSubscriptionId: 1 } },
      )
      .toArray();
    if (claimed.length || stripeBacked.length) {
      const cIds = claimed.map((b) => String(b._id));
      const sIds = stripeBacked.map((s) => String(s.business));
      throw new HttpException(
        `purgeBusinessData refused: delete set contains claimed or ` +
          `Stripe-backed businesses (claimed=[${cIds.join(',')}], ` +
          `stripe=[${sIds.join(',')}]). DOP only deletes seeded/unclaimed ` +
          `businesses. Aborting.`,
        400,
      );
    }

    // ── Media id gather (delete files/folders by these) ──
    const driveIds = await targetConn
      .collection('drives')
      .distinct('_id', { owner: { $in: ids } });
    const folderIds = await targetConn
      .collection('folders')
      .distinct('_id', {
        $or: [{ owner: { $in: ids } }, { drive: { $in: driveIds } }],
      });

    // ── Collection + filter specs (audit this list against the real DB) ──
    // PROVEN names (DOP already deletes these): events, eventlocations,
    //   eventschedules, outlets, menus, reviews, subscriptions, creditwallets,
    //   follows, feeds, drives, folders, files, businesses.
    // INFERRED names (VERIFY before first real run): templates,
    //   discardedschedules, pindrops, rewards, userrewards, rewardlocations,
    //   rewardvisits, brands, businessactivations, businessinteractions,
    //   creditledgers, departments, locationgroups, mobilespots,
    //   ownershiptransferrecords, referralredemptions, regions, scratches,
    //   transactions, consumerpurchases, referrals, checkins, checkinfeeds,
    //   broadcasts, notifications, tempaititles, tokens, userrolemappings, roles.
    const byBiz = { business: { $in: ids } };
    const byBizProfile = { businessProfile: { $in: ids } };
    const byBizId = { businessId: { $in: ids } };

    const specs: { c: string; f: Record<string, any> }[] = [
      // Event module
      { c: 'events', f: byBizProfile },
      { c: 'eventlocations', f: byBizProfile },
      { c: 'eventschedules', f: byBizId },
      { c: 'templates', f: byBizId },
      { c: 'discardedschedules', f: byBizId },
      { c: 'pindrops', f: byBiz },
      // Outlet
      { c: 'outlets', f: byBiz },
      // Rewards
      { c: 'rewards', f: byBizProfile },
      { c: 'userrewards', f: byBizProfile },
      { c: 'rewardlocations', f: byBiz },
      { c: 'rewardvisits', f: byBiz },
      // Business module
      { c: 'brands', f: byBizId },
      { c: 'businessactivations', f: byBiz },
      { c: 'businessinteractions', f: byBiz },
      { c: 'creditwallets', f: byBiz },
      { c: 'creditledgers', f: byBiz },
      { c: 'departments', f: byBiz },
      { c: 'locationgroups', f: byBiz },
      { c: 'menus', f: byBiz },
      { c: 'mobilespots', f: byBiz },
      { c: 'ownershiptransferrecords', f: byBiz },
      { c: 'referralredemptions', f: byBiz },
      { c: 'regions', f: byBiz },
      { c: 'reviews', f: byBiz },
      { c: 'scratches', f: byBiz },
      // Subscription module
      { c: 'subscriptions', f: byBiz },
      { c: 'transactions', f: byBiz },
      { c: 'consumerpurchases', f: byBiz },
      { c: 'referrals', f: byBiz },
      // Social
      { c: 'follows', f: { following: { $in: ids } } },
      { c: 'feeds', f: { creator: { $in: ids } } },
      { c: 'checkins', f: byBiz },
      { c: 'checkinfeeds', f: byBiz },
      // Notifications
      { c: 'broadcasts', f: byBiz },
      { c: 'notifications', f: byBiz },
      // AI
      { c: 'tempaititles', f: byBiz },
      // Auth
      { c: 'tokens', f: byBizProfile },
      // Roles (business-scoped)
      { c: 'userrolemappings', f: byBiz },
      { c: 'roles', f: byBiz },
      // ── Media (RETAINED — main-app version omits these) ──
      {
        c: 'files',
        f: {
          $or: [
            { drive: { $in: driveIds } },
            { parentDirectory: { $in: folderIds } },
          ],
        },
      },
      {
        c: 'folders',
        f: { $or: [{ owner: { $in: ids } }, { drive: { $in: driveIds } }] },
      },
      { c: 'drives', f: { owner: { $in: ids } } },
      // ── Business record itself (LAST) ──
      { c: 'businesses', f: { _id: { $in: ids } } },
    ];

    const summary: Record<string, number> = {};
    for (const { c, f } of specs) {
      try {
        if (dryRun) {
          summary[c] = await targetConn.collection(c).countDocuments(f);
        } else {
          const res = await targetConn.collection(c).deleteMany(f);
          summary[c] = res.deletedCount ?? 0;
        }
      } catch (err: any) {
        this.logger.error(`[PURGE] ${c} failed: ${err?.message}`);
        summary[c] = -1; // surface, don't silently swallow
      }
    }

    this.logger.log(
      `[PURGE${dryRun ? '-DRYRUN' : ''}] businesses=${ids.length} ` +
        Object.entries(summary)
          .filter(([, n]) => n !== 0)
          .map(([c, n]) => `${c}=${n}`)
          .join(' '),
    );
    return summary;
  }

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
