export type Environment = 'dev' | 'pre-prod' | 'staging' | 'production';

// ─── Seeding Session ─────────────────────────────────────
export interface SeedingStats {
  raw: number;
  validated: number;
  transformed: number;
  enriched: number;
  ready: number;
  published: number;
  failed: number;
  skipped: number;
}

export interface BotOperationStat {
  lastRunAt?: string | null;
  doneCount: number;
  failedCount: number;
}

export interface BotOperationsMap {
  reviews?: BotOperationStat;
  galleryMenu?: BotOperationStat;
  imageSync?: BotOperationStat;
  coverSync?: BotOperationStat;
}

export type BotJobType =
  | 'gallery_menu'
  | 'reviews'
  | 'image_sync'
  | 'cover_sync';

export type BotJobStatus = 'pending' | 'running' | 'done' | 'failed';

export interface BotJobBucket {
  pending: number;
  running: number;
  done: number;
  failed: number;
}

export interface SeedingSessionBotJobs {
  total: BotJobBucket;
  byType: Record<BotJobType, BotJobBucket>;
}

export interface ActiveBotJob {
  businessId: string;
  businessName: string;
  type: BotJobType;
  status: BotJobStatus;
  createdAt: string;
  attempts: number;
}

export interface CoverageAnalytics {
  totals: {
    totalRecords: number;
    published: number;
    inProd: number;
    cities: number;
    publishRate: number;
  };
  byCity: {
    city: string;
    state: string | null;
    total: number;
    published: number;
    pending: number;
  }[];
  prodSplit: { live: number; staging: number };
  byState: { state: string; published: number }[];
}

// New record-level snapshot returned by /seeding/coverage. Spec data
// contract: seeded/published come from seedingrecords; liveInProduction
// is an actual count over the prod target DB (null if unavailable).
export interface CoverageSnapshot {
  _id: string;
  generatedAt: string;
  generatedBy: string;
  totals: {
    seeded: number;
    published: number;
    publishRate: number;
    liveInProduction: number | null;
    citiesCovered: number;
    hostMetros: number;
  };
  byCity: {
    city: string;
    state: string | null;
    total: number;
    published: number;
    pending: number;
  }[];
  prodVsStaging: {
    published: number;
    liveInProduction: number | null;
  };
  citySharePublished: { city: string; published: number }[];
  prodConnectionError: string | null;
}

export interface MigratedToEntry {
  environment: string;
  sessionId: string;
  migratedAt: string;
}

export interface SeedingSession {
  _id: string;
  sessionId: string;
  name: string;
  description?: string;
  createdBy: string;
  environment: 'dev' | 'pre-prod' | 'staging' | 'production';
  status: SessionStatus;
  totalRecords: number;
  stats: SeedingStats;
  modules: string[];
  publishedAt?: string;
  publishedBy?: string;
  errorSummary?: string;
  type?: 'standard' | 'migration' | 'cvb';
  botOperations?: BotOperationsMap;
  dominantCity?: string | null;
  dominantState?: string | null;
  dominantIndustry?: string | null;
  dominantCategory?: string | null;
  migratedTo?: MigratedToEntry[];
  migratedFrom?: {
    sessionId: string;
    sessionName: string;
    environment: string;
    migratedAt: string;
  };
  createdAt: string;
  updatedAt: string;
}

export type SessionStatus =
  | 'draft'
  | 'validating'
  | 'validated'
  | 'transforming'
  | 'transformed'
  | 'enriching'
  | 'enriched'
  | 'ready'
  | 'publishing'
  | 'published'
  | 'failed'
  | 'cancelled'
  | 'migrating'
  | 'migrated';

// ─── Seeding Record ──────────────────────────────────────
export interface ValidationError {
  field: string;
  message: string;
  severity: 'error' | 'warning' | 'info';
}

export interface CvbFix {
  field: string;
  issue: string;
  currentValue: any;
  suggestedValue: any;
  riskLevel: 'safe' | 'manual';
  status: 'pending' | 'approved' | 'rejected' | 'applied';
  appliedAt?: string;
  appliedBy?: string;
}

export interface SeedingRecord {
  _id: string;
  sessionId: string;
  module: SeedingModule;
  status: RecordStatus;
  rawData: Record<string, any>;
  transformedData?: Record<string, any>;
  enrichmentData?: Record<string, any>;
  validationErrors: ValidationError[];
  publishedId?: string;
  publishedAt?: string;
  retryCount: number;
  errorMessage?: string;
  clientRefId?: string;
  metadata?: Record<string, any>;
  botScrape?: {
    status: string;
    startedAt?: string;
    completedAt?: string;
    currentStage?: string;
    currentDetail?: string;
    progress?: {
      gallery?: {
        status: string;
        folders: number;
        images: number;
        foldersTotal: number;
        currentFolder?: string;
      };
      menu?: {
        status: string;
        items: number;
      };
      reviews?: {
        status: string;
        current: number;
        total: number;
        expanding: number;
      };
    };
    reviewCount?: number;
    galleryFolders?: number;
    galleryImages?: number;
    menuItems?: number;
    error?: string;
  };
  cvbBusinessId?: string;
  cvbFixes?: CvbFix[];
  createdAt: string;
  updatedAt: string;
}

export type RecordStatus =
  | 'raw'
  | 'validated'
  | 'transformed'
  | 'enriched'
  | 'ready'
  | 'published'
  | 'failed'
  | 'skipped';

export type SeedingModule =
  | 'business'
  | 'outlet'
  | 'event'
  | 'event-location'
  | 'event-schedule'
  | 'menu'
  | 'media';

// ─── Seeding Log ─────────────────────────────────────────
export interface SeedingLog {
  _id: string;
  sessionId: string;
  recordId?: string;
  action: string;
  actor: string;
  fromStatus?: string;
  toStatus?: string;
  message?: string;
  metadata?: Record<string, any>;
  createdAt: string;
  updatedAt: string;
}

// ─── API Responses ───────────────────────────────────────
export interface ApiError {
  success: false;
  statusCode: number;
  code: string;
  message: string;
  field?: string;
  details?: Record<string, any>;
  timestamp: string;
  path: string;
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
}

// ─── Business ────────────────────────────────────────────
export interface Business {
  _id: string;
  name: string;
  status: number;
  email?: string;
  phone?: string;
  city?: string;
  isActive: boolean;
  uniqueId?: string;
  logo?: string;
  verificationStatus: string;
  createdAt: string;
}
