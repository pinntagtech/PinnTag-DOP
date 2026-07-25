import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../lib/api-client';

// ── Types (mirror apps/api/src/modules/seeding/console/*) ─────────────

export const GATE_CRITERIA = [
  'c1_active_outlet',
  'c2_real_cover',
  'c3_real_hours',
  'c4_taxonomy_present',
  'c5_valid_address',
  'c6_singleton_placeId',
  'c7_domestic_coords',
  'c9_verified_placeId',
  'c10_verified_email',
  'c11_verified_name',
] as const;

export type GateCriterion = (typeof GATE_CRITERIA)[number];

export const GATE_CRITERIA_LABELS: Record<GateCriterion, string> = {
  c1_active_outlet: 'Active outlet',
  c2_real_cover: 'Real cover',
  c3_real_hours: 'Real hours',
  c4_taxonomy_present: 'Taxonomy',
  c5_valid_address: 'Valid address',
  c6_singleton_placeId: 'Singleton placeId',
  c7_domestic_coords: 'Domestic coords',
  c9_verified_placeId: 'Verified placeId',
  c10_verified_email: 'Verified email',
  c11_verified_name: 'Verified name',
};

export type GateOverall =
  | 'passPerfect11'
  | 'passLegacy9'
  | 'failAny'
  | null;

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
  gateFails?: GateCriterion[];
  gatePasses?: GateCriterion[];
  gateOverall?: GateOverall;
}

export interface ConsoleSort {
  field: 'name' | 'city' | 'state' | 'placeId' | 'createdAt' | 'updatedAt';
  dir: 'asc' | 'desc';
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

export interface ConsoleFacetsResponse {
  totals: { total: number; passLegacy9: number; passPerfect11: number };
  failByCriterion: Record<GateCriterion, number>;
}

export interface GateFreshness {
  environment: string;
  oldestComputedAt: string | null;
  newestComputedAt: string | null;
  gatedCount: number;
  ungatedCount: number;
}

export interface GateRecomputeResult {
  environment: string;
  scanned: number;
  updated: number;
  duplicatePlaceIds: number;
  durationMs: number;
  computedAt: string;
  totals: {
    passLegacy9: number;
    passPerfect11: number;
    failByCriterion: Record<GateCriterion, number>;
  };
}

// ── Hooks ─────────────────────────────────────────────────────────────

export function useConsoleSearch(input: {
  environment: string;
  page: number;
  pageSize: number;
  sort: ConsoleSort;
  filter: ConsoleFilter;
}) {
  return useQuery({
    queryKey: ['console', 'search', input],
    queryFn: async () => {
      const { data } = await apiClient.post<ConsoleSearchResponse>(
        '/seeding/console/search',
        input,
      );
      return data;
    },
    placeholderData: (prev) => prev,
  });
}

export function useConsoleFacets(input: {
  environment: string;
  filter: ConsoleFilter;
}) {
  return useQuery({
    queryKey: ['console', 'facets', input],
    queryFn: async () => {
      const { data } = await apiClient.post<ConsoleFacetsResponse>(
        '/seeding/console/facets',
        input,
      );
      return data;
    },
    placeholderData: (prev) => prev,
  });
}

export function useGateFreshness(environment: string) {
  return useQuery({
    queryKey: ['console', 'freshness', environment],
    queryFn: async () => {
      const { data } = await apiClient.get<GateFreshness>(
        '/seeding/console/gate/freshness',
        { params: { environment } },
      );
      return data;
    },
  });
}

export function useGateRecompute() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { environment: string }) => {
      const { data } = await apiClient.post<GateRecomputeResult>(
        '/seeding/console/gate/recompute',
        input,
      );
      return data;
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['console', 'search'] });
      qc.invalidateQueries({ queryKey: ['console', 'facets'] });
      qc.invalidateQueries({
        queryKey: ['console', 'freshness', vars.environment],
      });
    },
  });
}
