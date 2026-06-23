export const SeedingEnvironments = {
  DEV: 'dev',
  PRE_PROD: 'pre-prod',
  STAGING: 'staging',
  PRODUCTION: 'production',
} as const;

export const SeedingSessionStatus = {
  DRAFT: 'draft',
  VALIDATING: 'validating',
  VALIDATED: 'validated',
  TRANSFORMING: 'transforming',
  TRANSFORMED: 'transformed',
  ENRICHING: 'enriching',
  ENRICHED: 'enriched',
  READY: 'ready',
  PUBLISHING: 'publishing',
  PUBLISHED: 'published',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  MIGRATING: 'migrating',
  MIGRATED: 'migrated',
  CVB_IMPORTING: 'cvb_importing',
  CVB_READY: 'cvb_ready',
} as const;

export const SeedingSessionType = {
  STANDARD: 'standard',
  MIGRATION: 'migration',
  CVB: 'cvb',
} as const;

export const SeedingRecordStatus = {
  RAW: 'raw',
  VALIDATED: 'validated',
  TRANSFORMED: 'transformed',
  ENRICHED: 'enriched',
  READY: 'ready',
  PUBLISHED: 'published',
  FAILED: 'failed',
  SKIPPED: 'skipped',
  BOT_SCRAPING: 'bot_scraping',
  BOT_DONE: 'bot_done',
  BOT_FAILED: 'bot_failed',
} as const;

export const BotScrapeStatus = {
  PENDING:  'pending',
  SCRAPING: 'scraping',
  DONE:     'done',
  FAILED:   'failed',
} as const;

export const SeedingModules = {
  BUSINESS: 'business',
  OUTLET: 'outlet',
  EVENT: 'event',
  EVENT_LOCATION: 'event-location',
  EVENT_SCHEDULE: 'event-schedule',
  MENU: 'menu',
  MEDIA: 'media',
} as const;

export const SeedingLogActions = {
  CREATED: 'created',
  VALIDATED: 'validated',
  VALIDATION_FAILED: 'validation_failed',
  TRANSFORMED: 'transformed',
  TRANSFORMATION_FAILED: 'transformation_failed',
  ENRICHED: 'enriched',
  ENRICHMENT_FAILED: 'enrichment_failed',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  PUBLISHED: 'published',
  PUBLISH_FAILED: 'publish_failed',
  SKIPPED: 'skipped',
  RETRIED: 'retried',
  STATUS_CHANGED: 'status_changed',
  SESSION_RESET: 'session_reset',
  RECORD_DELETED_FROM_TARGET: 'record_deleted_from_target',
  BOT_TRIGGERED: 'bot_triggered',
  BOT_WEBHOOK_RECEIVED: 'bot_webhook_received',
  BOT_REVIEWS_SAVED: 'bot_reviews_saved',
  BOT_GALLERY_SAVED: 'bot_gallery_saved',
  BOT_MENU_SAVED: 'bot_menu_saved',
  BOT_FAILED: 'bot_failed',
  MIGRATION_STARTED: 'migration_started',
  MIGRATION_RECORD_DONE: 'migration_record_done',
  MIGRATION_RECORD_SKIPPED: 'migration_record_skipped',
  MIGRATION_RECORD_OVERWRITTEN: 'migration_record_overwritten',
  MIGRATION_COMPLETE: 'migration_complete',
  MIGRATION_FAILED: 'migration_failed',
  CVB_IMPORT_STARTED: 'cvb_import_started',
  CVB_BUSINESSES_IMPORTED: 'cvb_businesses_imported',
  CVB_FIX_APPLIED: 'cvb_fix_applied',
  CVB_FIX_AUTO: 'cvb_fix_auto',
  CVB_FIX_REJECTED: 'cvb_fix_rejected',
  SCRAPER_IMPORT: 'scraper_import',
} as const;

export const ValidationSeverity = {
  ERROR: 'error',
  WARNING: 'warning',
  INFO: 'info',
} as const;

export const SeedingLogMessages = {
  sessionCreated: (name: string, env: string) =>
    `Session "${name}" created for ${env}`,
  statusChanged: (from: string, to: string) =>
    `Session status changed from ${from} to ${to}`,
  recordStatusChanged: (id: string, from: string, to: string) =>
    `Record ${id} status changed from ${from} to ${to}`,
  validationPassed: (id: string) =>
    `Record ${id} passed validation`,
  validationFailed: (id: string, count: number) =>
    `Record ${id} failed validation with ${count} error(s)`,
  transformationComplete: (id: string) =>
    `Record ${id} transformed successfully`,
  transformationFailed: (id: string, reason: string) =>
    `Record ${id} transformation failed: ${reason}`,
  enrichmentComplete: (id: string) =>
    `Record ${id} enriched successfully`,
  publishSuccess: (id: string, module: string) =>
    `Record ${id} (${module}) published successfully`,
  publishFailed: (id: string, reason: string) =>
    `Record ${id} publish failed: ${reason}`,
  sessionApproved: (id: string, actor: string) =>
    `Session ${id} approved for publishing by ${actor}`,
  sessionPublished: (id: string, env: string) =>
    `Session ${id} published to ${env}`,
  sessionCancelled: (id: string, actor: string) =>
    `Session ${id} cancelled by ${actor}`,
  bulkUploaded: (count: number, module: string) =>
    `${count} ${module} records uploaded`,
  sessionReset: (id: string, actor: string) =>
    `Session ${id} reset to draft by ${actor}`,
  recordDeletedFromTarget: (id: string, module: string) =>
    `${module} ${id} and related documents deleted from target DB`,
  botTriggered: (businessId: string, placeId: string) =>
    `Bot scrape triggered for business ${businessId} placeId ${placeId}`,
  botWebhookReceived: (businessId: string, reviewCount: number) =>
    `Bot webhook received for ${businessId} — ${reviewCount} reviews`,
  botReviewsSaved: (businessId: string, count: number) =>
    `${count} reviews saved for business ${businessId}`,
  botGallerySaved: (businessId: string, count: number) =>
    `${count} gallery items saved for business ${businessId}`,
  botMenuSaved: (businessId: string, count: number) =>
    `${count} menu items saved for business ${businessId}`,
} as const;

export const SeedingProjections = {
  sessionList: {
    sessionId: 1,
    name: 1,
    environment: 1,
    status: 1,
    createdBy: 1,
    totalRecords: 1,
    stats: 1,
    modules: 1,
    createdAt: 1,
    publishedAt: 1,
  },
  sessionDetail: {
    __v: 0,
  },
  recordList: {
    sessionId: 1,
    module: 1,
    status: 1,
    clientRefId: 1,
    validationErrors: 1,
    publishedId: 1,
    retryCount: 1,
    createdAt: 1,
    updatedAt: 1,
  },
  recordDetail: {
    __v: 0,
  },
  logList: {
    action: 1,
    actor: 1,
    fromStatus: 1,
    toStatus: 1,
    message: 1,
    recordId: 1,
    createdAt: 1,
  },
} as const;

export const EnvironmentUriKey = {
  [SeedingEnvironments.DEV]: 'database.pinntagDev',
  [SeedingEnvironments.PRE_PROD]: 'database.pinntagPreProd',
  [SeedingEnvironments.STAGING]: 'database.pinntagStaging',
  [SeedingEnvironments.PRODUCTION]: 'database.pinntagProd',
} as const;

export const SeedingErrorMessages = {
  sessionNotFound: (id: string) => `Session ${id} not found`,
  recordNotFound: (id: string) => `Record ${id} not found`,
  invalidEnvironment: (env: string) =>
    `No database URI configured for environment: ${env}`,
  missingTargetUri: (env: string) =>
    `Target URI not configured for environment: ${env}`,
  publishNotReady: (status: string) =>
    `Session must be in ready status to publish. Current: ${status}`,
  duplicateBusiness: (field: string, value: string) =>
    `Business already exists with ${field}: ${value}`,
  categoryNotFound: (names: string[]) =>
    `Categories not found in target DB: ${names.join(', ')}`,
  industryNotFound: (name: string) =>
    `Industry not found in target DB: ${name}`,
  businessUserNotFound: (email: string) =>
    `PinnTag business user not found with email: ${email}`,
  googlePlaceNotFound: (address: string) =>
    `No Google Place found for address: ${address}`,
} as const;

export const PostPublishActions = {
  OUTLET_CREATED: 'outlet_created',
  SUBSCRIPTION_CREATED: 'subscription_created',
  BUSINESS_ACTIVATED: 'business_activated',
  ACTIVATION_FAILED: 'activation_failed',
} as const;

export const PostPublishMessages = {
  activationComplete: (businessId: string) =>
    `Business ${businessId} activated — outlet + subscription created`,
  activationFailed: (businessId: string, reason: string) =>
    `Business ${businessId} activation failed: ${reason}`,
  outletCreated: (outletId: string) =>
    `Outlet ${outletId} created for business`,
  subscriptionCreated: (subId: string) =>
    `Free subscription ${subId} created`,
  driveCreated: (driveId: string) =>
    `Drive ${driveId} created for business`,
  galleryCreated: (folderId: string) =>
    `Gallery folder ${folderId} created`,
  driveSkipped: (reason: string) =>
    `Drive creation skipped: ${reason}`,
} as const;

export const SeedingDefaults = {
  STATS: {
    raw: 0,
    validated: 0,
    transformed: 0,
    enriched: 0,
    ready: 0,
    published: 0,
    failed: 0,
    skipped: 0,
  },
  BUSINESS_SEED_STATUS: 4.1,
  SORT_ORDER: { createdAt: -1 } as const,
  ACTOR_SYSTEM: 'system',
  SESSION_ID_PREFIX: 'DOP',
  SESSION_ID_RANDOM_LENGTH: 4,
} as const;
