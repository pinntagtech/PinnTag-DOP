import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  SeedingSession,
  SeedingSessionSchema,
} from './schemas/seeding-session.schema';
import {
  SeedingRecord,
  SeedingRecordSchema,
} from './schemas/seeding-record.schema';
import {
  SeedingLog,
  SeedingLogSchema,
} from './schemas/seeding-log.schema';
import { BotJob, BotJobSchema } from './schemas/bot-job.schema';
import { FixBatch, FixBatchSchema } from './schemas/fix-batch.schema';
import {
  DopSyncRun,
  DopSyncRunSchema,
  DopSyncState,
  DopSyncStateSchema,
} from './schemas/dop-sync-run.schema';
import {
  CoverageSnapshot,
  CoverageSnapshotSchema,
} from './schemas/coverage-snapshot.schema';
import { DbSyncService } from './sync/db-sync.service';
import { SyncController } from './sync/sync.controller';
import { CoverageService } from './coverage/coverage.service';
import { CoverageController } from './coverage/coverage.controller';
import { SeedingSessionService } from './seeding-session.service';
import { SeedingRecordService } from './seeding-record.service';
import { SeedingLogService } from './seeding-log.service';
import { SeedingPipelineService } from './seeding-pipeline.service';
import { PostPublishService } from './activation/post-publish.service';
import { DopLinkService } from './activation/dop-link.service';
import { BotWebhookService } from './bot/bot-webhook.service';
import { BotJobService } from './bot/bot-job.service';
import { BotSourceService } from './bot/bot-source.service';
import { BotSourceController } from './bot/bot-source.controller';
import { MigrationService } from './migration/migration.service';
import { CvbService } from './cvb/cvb.service';
import { CvbProdMigrationService } from './cvb-migration/cvb-prod-migration.service';
import { DataRepairService } from './data-repair/data-repair.service';
import { DataRepairController } from './data-repair/data-repair.controller';
import { ResolveService } from './resolve/resolve.service';
import { ResolveController } from './resolve/resolve.controller';
import { CoverB2SyncService } from './resolve/cover-b2-sync.service';
import { CoverB2SyncController } from './resolve/cover-b2-sync.controller';
import { AddressParseService } from './address-parse/address-parse.service';
import { AddressApplyService } from './address-parse/address-apply.service';
import { AddressParseController } from './address-parse/address-parse.controller';
import { FixBatchService } from './resolve/fix-batch.service';
import { EmailNotifier } from './resolve/notifier';
import { SeedingController } from './seeding.controller';
import { AuthModule } from '../auth/auth.module';
import { LocationsModule } from '../locations/locations.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: SeedingSession.name, schema: SeedingSessionSchema },
      { name: SeedingRecord.name, schema: SeedingRecordSchema },
      { name: SeedingLog.name, schema: SeedingLogSchema },
      { name: BotJob.name, schema: BotJobSchema },
      { name: FixBatch.name, schema: FixBatchSchema },
      { name: DopSyncRun.name, schema: DopSyncRunSchema },
      { name: DopSyncState.name, schema: DopSyncStateSchema },
      { name: CoverageSnapshot.name, schema: CoverageSnapshotSchema },
    ]),
    AuthModule,
    LocationsModule,
  ],
  controllers: [
    SeedingController,
    SyncController,
    CoverageController,
    DataRepairController,
    ResolveController,
    CoverB2SyncController,
    AddressParseController,
    BotSourceController,
  ],
  providers: [
    SeedingLogService,
    SeedingSessionService,
    SeedingRecordService,
    DopLinkService,
    PostPublishService,
    SeedingPipelineService,
    BotWebhookService,
    BotJobService,
    BotSourceService,
    MigrationService,
    CvbService,
    CvbProdMigrationService,
    DbSyncService,
    CoverageService,
    DataRepairService,
    ResolveService,
    CoverB2SyncService,
    AddressParseService,
    AddressApplyService,
    FixBatchService,
    EmailNotifier,
  ],
  exports: [
    SeedingSessionService,
    SeedingRecordService,
    SeedingLogService,
    SeedingPipelineService,
    PostPublishService,
    BotWebhookService,
    BotJobService,
    MigrationService,
    CvbService,
    CvbProdMigrationService,
    DataRepairService,
    ResolveService,
  ],
})
export class SeedingModule {}
