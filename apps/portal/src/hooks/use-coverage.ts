import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../lib/api-client';
import type { CoverageSnapshot } from '@pinntag-dop/types';

const coverageKey = ['coverage', 'snapshot'] as const;

export function useCoverage() {
  return useQuery({
    queryKey: coverageKey,
    queryFn: async () => {
      const { data } = await apiClient.get<CoverageSnapshot>(
        '/seeding/coverage',
      );
      return data;
    },
    // Heavy aggregation + a live prod connection — cache aggressively,
    // refresh on demand via the Refresh button only.
    staleTime: 5 * 60 * 1000,
  });
}

export function useRefreshCoverage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data } = await apiClient.post<CoverageSnapshot>(
        '/seeding/coverage/refresh',
      );
      return data;
    },
    onSuccess: (data) => {
      queryClient.setQueryData(coverageKey, data);
    },
  });
}
