import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../lib/api-client';
import type { SeedingRecord } from '@pinntag-dop/types';

export const recordKeys = {
  all: ['records'] as const,
  session: (sessionId: string, filters: Record<string, unknown>) =>
    [...recordKeys.all, 'session', sessionId, filters] as const,
  detail: (id: string) =>
    [...recordKeys.all, 'detail', id] as const,
};

export function useSessionRecords(
  sessionId: string,
  filters: { module?: string; status?: string } = {},
  options: { jobsActive?: boolean } = {},
) {
  const jobsActive = !!options.jobsActive;
  return useQuery({
    queryKey: recordKeys.session(sessionId, filters),
    queryFn: async () => {
      const { data } = await apiClient.get<SeedingRecord[]>(
        `/seeding/sessions/${sessionId}/records/full`,
        { params: filters },
      );
      return data;
    },
    enabled: !!sessionId,
    // Poll the heavy /records/full only while bot jobs are running.
    // When idle the query relies on react-query's normal cache + an
    // explicit invalidate on jobsActive flipping false → true (handled
    // by the caller in SessionDetailPage).
    refetchInterval: jobsActive ? 4000 : false,
    refetchIntervalInBackground: jobsActive,
    refetchOnWindowFocus: true,
    refetchOnMount: true,
  });
}

export function useUploadRecords(sessionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: {
      module: string;
      records: Record<string, any>[];
    }) => {
      const { data } = await apiClient.post(
        `/seeding/sessions/${sessionId}/records`,
        payload,
      );
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: recordKeys.all });
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
    },
  });
}

export function useReEnrich(sessionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (recordIds: string[]) => {
      const { data } = await apiClient.post(
        `/seeding/sessions/${sessionId}/re-enrich`,
        { actor: 'Operator', recordIds },
      );
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: recordKeys.all });
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
    },
  });
}

export function useRecord(sessionId: string, recordId: string) {
  return useQuery({
    queryKey: recordKeys.detail(recordId),
    queryFn: async () => {
      const { data } = await apiClient.get<SeedingRecord>(
        `/seeding/sessions/${sessionId}/records/${recordId}/full`,
      );
      return data;
    },
    enabled: !!sessionId && !!recordId,
    staleTime: 0,
    gcTime: 0,
    refetchInterval: () => 2000,
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: true,
    refetchOnMount: true,
  });
}
