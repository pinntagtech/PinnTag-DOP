import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../lib/api-client';

export type CoverBackfillStats = {
  environment: string;
  totalCoverless: number;
  inFlight: number;
  batchSize: number;
};

export type QueueBatchResult = {
  queued: number;
  requested: number;
  skippedInFlight: number;
  remainingCoverless: number;
};

const statsKey = ['cover-backfill', 'stats'] as const;

export function useCoverBackfillStats() {
  return useQuery({
    queryKey: statsKey,
    queryFn: async () => {
      const { data } = await apiClient.get<CoverBackfillStats>(
        '/seeding/cover-backfill/stats',
      );
      return data;
    },
    refetchInterval: 5000,
  });
}

export function useQueueCoverBatch() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data } = await apiClient.post<QueueBatchResult>(
        '/seeding/cover-backfill/queue-batch',
      );
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: statsKey });
    },
  });
}
