import { GATE_CRITERIA, GateCriterionKey } from './gate-predicates';

export type GateCriterion = GateCriterionKey;

// Keep the export so consumers importing from console.types get the
// canonical list without also depending on gate-predicates.
export { GATE_CRITERIA };

export type GateOverall = 'passPerfect11' | 'passLegacy9' | 'failAny' | null;

// Cohort segments correspond to seedProvenance.sources[] entries. The
// portal exposes All / Crawler / CVB / Manual seeder as chips; server
// side this maps to `seedProvenance.sources: {$in: [cohort]}`. Kept as
// a string literal union rather than an enum so the URL-serialization
// path stays trivial.
export type CohortSource = 'crawler' | 'cvb' | 'manual_seeder';

export interface ConsoleFilter {
  q?: string;
  state?: string[];
  city?: string[];
  industry?: string[];
  category?: string[];
  isActive?: boolean;
  hasWebsite?: boolean;
  hasEmail?: boolean;
  duplicatePlaceIdOnly?: boolean;
  resolveHoursStatus?: string[];
  cohort?: CohortSource;
  // AND across the listed criteria — a record must FAIL all of them.
  // Do not present this as OR in the UI (the naive read).
  gateFails?: GateCriterion[];
  gatePasses?: GateCriterion[];
  gateOverall?: GateOverall;
}

export interface ConsoleSort {
  field: 'name' | 'city' | 'state' | 'placeId' | 'createdAt' | 'updatedAt';
  dir: 'asc' | 'desc';
}

export interface ConsoleSearchRequest {
  environment: string;
  page?: number;
  pageSize?: number;
  sort?: ConsoleSort;
  filter?: ConsoleFilter;
}

export interface ConsoleBusinessRow {
  _id: string;
  name: string | null;
  city: string | null;
  state: string | null;
  isActive: boolean;
  cover: string | null;
  coverThumbnail: string | null;
  website: string | null;
  email: string | null;
  addressLine1: string | null;
  placeId: string | null;
  resolveStatus: Record<string, any> | null;
  gateStatus: Record<string, any> | null;
  emailVerification: Record<string, any> | null;
}

export interface ConsoleSearchResponse {
  items: ConsoleBusinessRow[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ConsoleFacetsRequest {
  environment: string;
  filter?: ConsoleFilter;
}

export interface ConsoleFacetsResponse {
  totals: {
    total: number;
    passLegacy9: number;
    passPerfect11: number;
  };
  failByCriterion: Record<string, number>;
}

// ── Selection + actions + runs ──────────────────────────────────────
//
// mode: 'ids'     → the client hand-picked specific rows. `ids` is the
//                    concrete list; payload size scales with selection.
// mode: 'filter'  → "select all N matching this filter". The client
//                    carries the QUERY, never the ID list — a 20k-record
//                    selection is a small payload. Server iterates a
//                    cursor over the same filter used by console search,
//                    honouring excludeIds for anything unchecked after
//                    select-all.
//
// Never materialize the full ID list server-side for filter mode.
export type ConsoleSelection =
  | { mode: 'ids'; ids: string[] }
  | { mode: 'filter'; filter?: ConsoleFilter; excludeIds?: string[] };

// Every action shipped in Phase B. `create_missing_outlet` is
// deliberately absent — the underlying helper copies parent business
// address fields onto the outlet, and outlets are distinct physical
// locations. It ships when a non-copying helper exists.
export type ConsoleActionType =
  | 'resync_city'
  | 'dedup_place_id'
  | 'strip_placeholder_covers'
  | 'trigger_email_scrape'
  | 'trigger_cover_sync'
  | 'trigger_image_sync'
  | 'trigger_gallery_menu'
  | 'trigger_reviews'
  | 're_resolve'
  | 'activate'
  | 'deactivate'
  | 'gate_recompute'
  | 'provenance_recompute';

export type ConsoleRunStatus =
  | 'queued'
  | 'running'
  | 'done'
  | 'failed'
  | 'cancelled';

export interface ConsoleRunLogEntry {
  ts: string;
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface ConsoleRunSummary {
  _id: string;
  action: ConsoleActionType;
  environment: string;
  selectionSummary: Record<string, any>;
  dryRun: boolean;
  total: number;
  processed: number;
  succeeded: number;
  failed: number;
  skipped: number;
  status: ConsoleRunStatus;
  startedBy: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  createdAt: string;
}

export interface ConsoleRunDetail extends ConsoleRunSummary {
  log: ConsoleRunLogEntry[];
  result?: Record<string, any>;
}

export interface ConsoleActionRequest {
  environment: string;
  action: ConsoleActionType;
  selection: ConsoleSelection;
  dryRun?: boolean;
  adminPassword?: string;
  options?: Record<string, any>;
}

export interface SelectionPreviewRequest {
  environment: string;
  selection: ConsoleSelection;
}
