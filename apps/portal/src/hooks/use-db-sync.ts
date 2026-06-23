import { useMutation, useQuery } from '@tanstack/react-query';
import { apiClient } from '../lib/api-client';

export type SyncEnvironment = 'staging' | 'pre-prod' | 'production';

export interface SyncTotals {
  targeted: number;
  toPatch: number;
  alreadySynced: number;
  assertionFailed: number;
  missingInTarget: number;
  coverageGap: number;
}

export interface SyncDiff {
  businessId: string;
  sessionId?: string;
  recordId?: string;
  outcome:
    | 'patched'
    | 'skipped'
    | 'failed'
    | 'assertion_failed'
    | 'missing';
  changedFields: string[];
  businessSet?: Record<string, unknown>;
  outletPatches?: Array<{
    outletId: string;
    set: Record<string, unknown>;
    changedFields: string[];
  }>;
  arrayRepair?: Record<string, unknown>;
  walletMissing?: boolean;
  linkMissing?: boolean;
  error?: string;
}

export interface PreviewReport {
  runId: string;
  environment: SyncEnvironment;
  totals: SyncTotals;
  diffs: SyncDiff[];
}

export interface ApplyReport {
  runId: string;
  environment: SyncEnvironment;
  totals: SyncTotals & { patched: number; failed: number };
  results: Array<{
    businessId: string;
    outcome: SyncDiff['outcome'];
    changedFields: string[];
    error?: string;
  }>;
}

export interface SyncRun {
  _id: string;
  environment: SyncEnvironment;
  status:
    | 'previewing'
    | 'previewed'
    | 'applying'
    | 'completed'
    | 'failed';
  startedBy: string;
  startedAt: string;
  finishedAt?: string;
  totals: SyncTotals & { patched?: number; failed?: number };
  results: Array<{
    businessId: string;
    outcome: SyncDiff['outcome'];
    changedFields: string[];
    error?: string;
  }>;
  errorMessage?: string;
  createdAt: string;
}

export function useSyncPreview() {
  return useMutation({
    mutationFn: async (payload: { environment: SyncEnvironment }) => {
      const { data } = await apiClient.post<PreviewReport>(
        '/seeding/sync/preview',
        payload,
      );
      return data;
    },
  });
}

export function useSyncApply() {
  return useMutation({
    mutationFn: async (payload: {
      environment: SyncEnvironment;
      adminPassword?: string;
    }) => {
      const { data } = await apiClient.post<ApplyReport>(
        '/seeding/sync/apply',
        payload,
      );
      return data;
    },
  });
}

export function useSyncRuns(environment?: SyncEnvironment) {
  return useQuery({
    queryKey: ['sync-runs', environment ?? 'all'],
    queryFn: async () => {
      const { data } = await apiClient.get<SyncRun[]>(
        '/seeding/sync/runs',
        { params: environment ? { environment } : {} },
      );
      return data;
    },
    staleTime: 30_000,
  });
}
