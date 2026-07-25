import { GATE_CRITERIA, GateCriterionKey } from './gate-predicates';

export type GateCriterion = GateCriterionKey;

// Keep the export so consumers importing from console.types get the
// canonical list without also depending on gate-predicates.
export { GATE_CRITERIA };

export type GateOverall = 'passPerfect11' | 'passLegacy9' | 'failAny' | null;

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
