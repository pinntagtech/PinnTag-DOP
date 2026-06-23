import {
  useQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import { apiClient } from '../lib/api-client';
import type {
  SeedingSession,
  SeedingLog,
  SeedingSessionBotJobs,
  ActiveBotJob,
} from '@pinntag-dop/types';

export const sessionKeys = {
  all: ['sessions'] as const,
  list: (filters: Record<string, unknown>) =>
    [...sessionKeys.all, 'list', filters] as const,
  detail: (id: string) =>
    [...sessionKeys.all, 'detail', id] as const,
  stats: (id: string) =>
    [...sessionKeys.all, 'stats', id] as const,
  logs: (id: string) =>
    [...sessionKeys.all, 'logs', id] as const,
  botJobs: (id: string) =>
    [...sessionKeys.all, 'bot-jobs', id] as const,
  activeBotJobs: (id: string) =>
    [...sessionKeys.all, 'bot-jobs', id, 'active'] as const,
};

export function useSessions(
  filters: {
    environment?: string;
    status?: string;
    createdBy?: string;
  } = {},
) {
  return useQuery({
    queryKey: sessionKeys.list(filters),
    queryFn: async () => {
      const { data } = await apiClient.get<SeedingSession[]>(
        '/seeding/sessions',
        { params: filters },
      );
      return data;
    },
    refetchInterval: 10000,
  });
}

export function useSession(id: string) {
  return useQuery({
    queryKey: sessionKeys.detail(id),
    queryFn: async () => {
      const { data } = await apiClient.get<SeedingSession>(
        `/seeding/sessions/${id}`,
      );
      return data;
    },
    enabled: !!id,
    staleTime: 0,
    gcTime: 0,
    refetchInterval: () => 3000,
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: true,
    refetchOnMount: true,
  });
}

export function useSessionStats(id: string) {
  return useQuery({
    queryKey: sessionKeys.stats(id),
    queryFn: async () => {
      const { data } = await apiClient.get(
        `/seeding/sessions/${id}/stats`,
      );
      return data;
    },
    enabled: !!id,
    refetchInterval: 3000,
  });
}

export function useSessionLogs(id: string) {
  return useQuery({
    queryKey: sessionKeys.logs(id),
    queryFn: async () => {
      const { data } = await apiClient.get<SeedingLog[]>(
        `/seeding/sessions/${id}/logs`,
      );
      return data;
    },
    enabled: !!id,
    staleTime: 0,
    gcTime: 0,
    refetchInterval: () => 3000,
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: true,
    refetchOnMount: true,
  });
}

export function useSessionBotJobs(id: string) {
  return useQuery({
    queryKey: sessionKeys.botJobs(id),
    queryFn: async () => {
      const { data } = await apiClient.get<SeedingSessionBotJobs>(
        `/seeding/sessions/${id}/bot-jobs`,
      );
      return data;
    },
    enabled: !!id,
    refetchInterval: 3000,
    refetchIntervalInBackground: true,
  });
}

export function useActiveSessionJobs(id: string) {
  return useQuery({
    queryKey: sessionKeys.activeBotJobs(id),
    queryFn: async () => {
      const { data } = await apiClient.get<ActiveBotJob[]>(
        `/seeding/sessions/${id}/bot-jobs/active`,
      );
      return data;
    },
    enabled: !!id,
    refetchInterval: 3000,
    refetchIntervalInBackground: true,
  });
}

export function useCreateSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: {
      name: string;
      description?: string;
      environment: string;
      modules: string[];
      type?: 'standard' | 'cvb';
    }) => {
      const { data } = await apiClient.post(
        '/seeding/sessions',
        payload,
      );
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: sessionKeys.all });
    },
  });
}

export function useImportScraperData() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: {
      scraperFile: File;
      emailFile?: File;
      name: string;
      environment: string;
      actor: string;
      defaultIndustry?: string;
      defaultCategories?: string[];
      defaultCity?: string;
      defaultState?: string;
    }) => {
      const formData = new FormData();
      formData.append('files', payload.scraperFile);
      if (payload.emailFile) {
        formData.append('files', payload.emailFile);
      }
      formData.append('name', payload.name);
      formData.append('environment', payload.environment);
      formData.append('actor', payload.actor);
      if (payload.defaultIndustry) {
        formData.append('defaultIndustry', payload.defaultIndustry);
      }
      if (payload.defaultCategories) {
        formData.append(
          'defaultCategories',
          JSON.stringify(payload.defaultCategories),
        );
      }
      if (payload.defaultCity) {
        formData.append('defaultCity', payload.defaultCity);
      }
      if (payload.defaultState) {
        formData.append('defaultState', payload.defaultState);
      }

      const { data } = await apiClient.post(
        '/seeding/sessions/import-scraper',
        formData,
        {
          headers: {
            'Content-Type': 'multipart/form-data',
          },
        },
      );
      return data as {
        sessionId: string;
        stats: {
          processed: number;
          noWebsite: number;
          emailMatched: number;
          emailUnmatched: number;
          categoryMapped: number;
          categoryFallback: number;
          // Stage B data-quality counters.
          hoursUnparsed: number;
          addressInvalid: number;
          noCoords: number;
          noPlaceId: number;
          noName: number;
        };
      };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: sessionKeys.all });
    },
  });
}

export function useResetSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      sessionId,
      adminPassword,
    }: {
      sessionId: string;
      adminPassword: string;
    }) => {
      const { data } = await apiClient.post(
        `/seeding/sessions/${sessionId}/reset`,
        { adminPassword },
      );
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: sessionKeys.all });
      queryClient.invalidateQueries({ queryKey: ['records'] });
    },
  });
}

export function useDeleteSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      sessionId,
      adminPassword,
    }: {
      sessionId: string;
      adminPassword: string;
    }) => {
      const { data } = await apiClient.delete(
        `/seeding/sessions/${sessionId}`,
        { data: { adminPassword } },
      );
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: sessionKeys.all });
      queryClient.invalidateQueries({ queryKey: ['records'] });
    },
  });
}

export function useTriggerBotScrape() {
  return useMutation({
    mutationFn: async (payload: {
      sessionId: string;
      records: {
        placeId: string;
        businessId: string;
        businessName: string;
        environment: string;
        maxReviews?: number;
      }[];
      skipReviews?: boolean;
      skipGallery?: boolean;
      skipMenu?: boolean;
      type?: 'gallery_menu' | 'reviews' | 'image_sync' | 'cover_sync';
    }) => {
      const { data } = await apiClient.post(
        `/seeding/sessions/${payload.sessionId}/trigger-bot`,
        {
          records: payload.records,
          skipReviews: payload.skipReviews ?? false,
          skipGallery: payload.skipGallery ?? false,
          skipMenu: payload.skipMenu ?? false,
          type: payload.type,
        },
      );
      return data as { created: number };
    },
  });
}

export function useAssignCoverAsLogo() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: {
      sessionId: string;
      environment: string;
    }) => {
      const { data } = await apiClient.post(
        `/seeding/sessions/${payload.sessionId}/assign-cover-as-logo`,
        { environment: payload.environment },
      );
      return data as { updated: number; message: string };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ['sessions'],
      });
    },
  });
}

export function useResetBotStages() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: {
      sessionId: string;
      stages: ('gallery' | 'menu' | 'reviews')[];
      environment: string;
    }) => {
      const { data } = await apiClient.post(
        `/seeding/sessions/${payload.sessionId}/reset-bot`,
        {
          stages: payload.stages,
          environment: payload.environment,
        },
      );
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ['records'],
      });
    },
  });
}

export function useCheckMigration() {
  return useMutation({
    mutationFn: async (payload: {
      sessionId: string;
      targetEnvironment: string;
      recordIds?: string[];
    }) => {
      const { data } = await apiClient.post(
        `/seeding/sessions/${payload.sessionId}/check-migration`,
        {
          targetEnvironment: payload.targetEnvironment,
          recordIds: payload.recordIds,
        },
      );
      return data as {
        conflicts: {
          recordId: string;
          businessName: string;
          placeId: string;
          existingBusinessId: string;
        }[];
        clean: {
          recordId: string;
          businessName: string;
          placeId: string;
        }[];
      };
    },
  });
}

export function useMigrateSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: {
      sessionId: string;
      targetEnvironment: string;
      recordIds?: string[];
      conflictResolution: Record<string, 'skip' | 'overwrite'>;
    }) => {
      const { data } = await apiClient.post(
        `/seeding/sessions/${payload.sessionId}/migrate`,
        {
          targetEnvironment: payload.targetEnvironment,
          recordIds: payload.recordIds,
          conflictResolution: payload.conflictResolution,
        },
      );
      return data as { migrationSessionId: string };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ['sessions'],
      });
    },
  });
}

export function useCvbBusinesses(filters: {
  city?: string;
  state?: string;
  industry?: string;
  category?: string;
  search?: string;
  hasPlaceId?: boolean;
  hasMissingFields?: boolean;
  sortBy?: 'newest' | 'oldest' | 'name';
  page?: number;
  limit?: number;
}) {
  return useQuery({
    queryKey: ['cvb-businesses', filters],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (filters.city) params.set('city', filters.city);
      if (filters.state) params.set('state', filters.state);
      if (filters.industry)
        params.set('industry', filters.industry);
      if (filters.category)
        params.set('category', filters.category);
      if (filters.search)
        params.set('search', filters.search);
      if (filters.hasPlaceId !== undefined)
        params.set('hasPlaceId', String(filters.hasPlaceId));
      if (filters.hasMissingFields)
        params.set('hasMissingFields', 'true');
      if (filters.sortBy)
        params.set('sortBy', filters.sortBy);
      if (filters.page)
        params.set('page', String(filters.page));
      if (filters.limit)
        params.set('limit', String(filters.limit));
      const { data } = await apiClient.get(
        `/seeding/cvb/businesses?${params}`,
      );
      return data as {
        businesses: any[];
        total: number;
        page: number;
        pages: number;
      };
    },
    enabled: false,
  });
}

export function useCvbFilters() {
  return useQuery({
    queryKey: ['cvb-filters'],
    queryFn: async () => {
      const { data } = await apiClient.get(
        '/seeding/cvb/filters',
      );
      return data as {
        cities: string[];
        states: string[];
        industries: { _id: string; name: string }[];
        categories: { _id: string; name: string }[];
      };
    },
    staleTime: 5 * 60 * 1000,
  });
}

export function useImportCvb() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: {
      sessionId: string;
      businessIds: string[];
    }) => {
      const { data } = await apiClient.post(
        `/seeding/sessions/${payload.sessionId}/import-cvb`,
        { businessIds: payload.businessIds },
      );
      return data as {
        imported: number;
        skipped: number;
        duplicates: any[];
      };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['records'] });
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
    },
  });
}

export function useCvbValidate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: { sessionId: string }) => {
      const { data } = await apiClient.post(
        `/seeding/sessions/${payload.sessionId}/cvb-validate`,
        {},
      );
      return data as {
        total: number;
        withIssues: number;
        clean: number;
        autoFixable: number;
      };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['records'] });
    },
  });
}

export function useCvbAutoFix() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: { sessionId: string }) => {
      const { data } = await apiClient.post(
        `/seeding/sessions/${payload.sessionId}/cvb-autofix`,
        {},
      );
      return data as { fixed: number; skipped: number };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['records'] });
    },
  });
}

export function useCvbApplyFix() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: {
      recordId: string;
      field: string;
      value: any;
      mode: 'manual' | 'auto';
    }) => {
      const { data } = await apiClient.post(
        `/seeding/records/${payload.recordId}/cvb-apply-fix`,
        {
          field: payload.field,
          value: payload.value,
          mode: payload.mode,
        },
      );
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['records'] });
    },
  });
}

export function useCvbRejectFix() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: {
      recordId: string;
      field: string;
    }) => {
      const { data } = await apiClient.post(
        `/seeding/records/${payload.recordId}/cvb-reject-fix`,
        { field: payload.field },
      );
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['records'] });
    },
  });
}

export function useUpdateRecord() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: {
      recordId: string;
      update: {
        transformedData?: any;
        rawData?: any;
      };
    }) => {
      const { data } = await apiClient.patch(
        `/seeding/records/${payload.recordId}`,
        payload.update,
      );
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
      queryClient.invalidateQueries({ queryKey: ['records'] });
    },
  });
}

export function usePipelineAction(sessionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      action:
        | 'validate'
        | 'transform'
        | 'enrich'
        | 'approve'
        | 'publish',
    ) => {
      const { data } = await apiClient.post(
        `/seeding/sessions/${sessionId}/${action}`,
        {},
      );
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: sessionKeys.all });
      queryClient.invalidateQueries({ queryKey: ['records'] });
    },
  });
}
