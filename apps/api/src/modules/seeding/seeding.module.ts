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
import { VerifyAndFixService } from './verify/verify-and-fix.service';
import { CoverBackfillService } from './cover-backfill/cover-backfill.service';
import { CoverBackfillController } from './cover-backfill/cover-backfill.controller';
import { GateService } from './console/gate.service';
import { ConsoleService } from './console/console.service';
import { ProvenanceService } from './console/provenance.service';
import { RunService } from './console/run.service';
import {
  ConsoleRun,
  ConsoleRunSchema,
} from './console/console-run.schema';
import { ConsoleController } from './console/console.controller';
import {
  DiscoveryRegion,
  DiscoveryRegionSchema,
} from './discovery/schemas/discovery-region.schema';
import {
  DiscoveryRun,
  DiscoveryRunSchema,
} from './discovery/schemas/discovery-run.schema';
import {
  DiscoveryProcessed,
  DiscoveryProcessedSchema,
} from './discovery/schemas/discovery-processed.schema';
import { DiscoveryService } from './discovery/discovery.service';
import { DiscoveryRunService } from './discovery/discovery-run.service';
import { DiscoveryController } from './discovery/discovery.controller';
import { JudgmentService } from './judgment/judgment.service';
import { ClaudeClient } from './judgment/claude-client';
import { OllamaClient } from './judgment/ollama-client';
import { TaxonomyLoader } from './judgment/taxonomy-loader';
import { CategoryJudge } from './judgment/judges/category-judge';
import { CityJudge } from './judgment/judges/city-judge';
import { AnomalyJudge } from './judgment/judges/anomaly-judge';
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
      { name: ConsoleRun.name, schema: ConsoleRunSchema },
      { name: DiscoveryRegion.name, schema: DiscoveryRegionSchema },
      { name: DiscoveryRun.name, schema: DiscoveryRunSchema },
      { name: DiscoveryProcessed.name, schema: DiscoveryProcessedSchema },
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
    CoverBackfillController,
    ConsoleController,
    DiscoveryController,
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
    VerifyAndFixService,
    CoverBackfillService,
    GateService,
    ConsoleService,
    ProvenanceService,
    RunService,
    DiscoveryService,
    DiscoveryRunService,
    JudgmentService,
    ClaudeClient,
    OllamaClient,
    TaxonomyLoader,
    CategoryJudge,
    CityJudge,
    AnomalyJudge,
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
