import { useCallback, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { apiClient } from '../lib/api-client';

export type GatedTargetEnv = 'pre-prod' | 'production';

export interface GatedPreviewReport {
  sourceEnv: string;
  targetEnvironment: GatedTargetEnv;
  totals: {
    publishedTotal: number;
    eligible: number;
    excluded: number;
    excludedByReason: Record<string, number>;
  };
  conflicts: number;
  willMigrate: number;
  sample: Array<{ name: string; placeId: string; stagingId: string }>;
}

export interface GatedApplyBatchReport {
  migrationSessionId: string;
  totals: {
    publishedTotal: number;
    eligible: number;
    conflictsSkipped: number;
    migrated: number;
    failed: number;
  };
}

export interface BatchedApplyProgress {
  batchNumber: number;
  batches: GatedApplyBatchReport[];
  totals: {
    migrated: number;
    conflictsSkipped: number;
    failed: number;
  };
  migrationSessionIds: string[];
  currentBatch?: GatedApplyBatchReport;
  done: boolean;
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

const BATCH_LIMIT = 500;
const MAX_BATCHES = 20; // hard safety cap

export function useGatedPreview() {
  return useMutation({
    mutationFn: async (payload: { targetEnvironment: GatedTargetEnv }) => {
      const { data } = await apiClient.post<GatedPreviewReport>(
        '/seeding/migration/gated/preview',
        payload,
      );
      return data;
    },
  });
}

// The apply orchestrator loops the backend endpoint in limit:500 batches
// until a batch returns migrated:0 (nothing left) or MAX_BATCHES is hit.
// A single 2,600-record run hits the nginx 5-min timeout; batches of 500
// finish comfortably under it. Re-running is safe — the gated scope
// re-evaluates against staging and already-migrated placeIds resolve
// as conflicts (skip).
export function useBatchedGatedApply() {
  const [progress, setProgress] = useState<BatchedApplyProgress | null>(null);
  const [isRunning, setIsRunning] = useState(false);

  const run = useCallback(
    async (input: {
      targetEnvironment: GatedTargetEnv;
      adminPassword?: string;
      conflictMode?: 'skip' | 'overwrite';
    }) => {
      setIsRunning(true);
      const state: BatchedApplyProgress = {
        batchNumber: 0,
        batches: [],
        totals: { migrated: 0, conflictsSkipped: 0, failed: 0 },
        migrationSessionIds: [],
        done: false,
        startedAt: Date.now(),
      };
      setProgress({ ...state });

      try {
        for (let i = 0; i < MAX_BATCHES; i++) {
          state.batchNumber = i + 1;
          setProgress({ ...state, currentBatch: undefined });

          const { data } = await apiClient.post<GatedApplyBatchReport>(
            '/seeding/migration/gated/apply',
            {
              targetEnvironment: input.targetEnvironment,
              adminPassword: input.adminPassword,
              conflictMode: input.conflictMode ?? 'skip',
              limit: BATCH_LIMIT,
            },
          );

          state.batches.push(data);
          state.currentBatch = data;
          state.totals.migrated += data.totals.migrated;
          state.totals.conflictsSkipped += data.totals.conflictsSkipped;
          state.totals.failed += data.totals.failed;
          if (data.migrationSessionId) {
            state.migrationSessionIds.push(data.migrationSessionId);
          }
          setProgress({ ...state });

          // Stop when a batch reports nothing new was migrated. This means
          // the eligible-minus-conflicts population is drained, or all
          // remaining candidates are conflicts (skip).
          if (data.totals.migrated === 0) {
            state.done = true;
            state.finishedAt = Date.now();
            setProgress({ ...state });
            break;
          }
        }
        if (!state.done) {
          state.done = true;
          state.finishedAt = Date.now();
          state.error =
            `Hit max batches (${MAX_BATCHES}); stopping. Re-run to continue.`;
          setProgress({ ...state });
        }
      } catch (err: unknown) {
        state.done = true;
        state.finishedAt = Date.now();
        state.error =
          err instanceof Error ? err.message : 'Apply batch failed';
        setProgress({ ...state });
      } finally {
        setIsRunning(false);
      }
    },
    [],
  );

  const reset = useCallback(() => {
    setProgress(null);
    setIsRunning(false);
  }, []);

  return { run, progress, isRunning, reset };
}
