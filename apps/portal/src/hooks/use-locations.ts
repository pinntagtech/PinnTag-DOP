import {
  useQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import { apiClient } from '../lib/api-client';

export interface LocationArea {
  name: string;
  subRegion?: string;
  state?: string;
}

export interface SeedingLocation {
  _id: string;
  city: string;
  cityKey: string;
  state: string;
  areas: LocationArea[];
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

const locationKeys = {
  all: ['locations'] as const,
  detail: (id: string) => ['locations', 'detail', id] as const,
};

export function useLocations() {
  return useQuery({
    queryKey: locationKeys.all,
    queryFn: async () => {
      const { data } = await apiClient.get<SeedingLocation[]>(
        '/locations',
      );
      return data;
    },
  });
}

export function useCreateLocation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload: {
      city: string;
      state: string;
      areas?: LocationArea[];
      isActive?: boolean;
    }) => {
      const { data } = await apiClient.post<SeedingLocation>(
        '/locations',
        payload,
      );
      return data;
    },
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: locationKeys.all }),
  });
}

export function useUpdateLocation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload: {
      id: string;
      city?: string;
      state?: string;
      isActive?: boolean;
    }) => {
      const { id, ...patch } = payload;
      const { data } = await apiClient.patch<SeedingLocation>(
        `/locations/${id}`,
        patch,
      );
      return data;
    },
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: locationKeys.all }),
  });
}

export function useDeleteLocation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data } = await apiClient.delete(`/locations/${id}`);
      return data;
    },
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: locationKeys.all }),
  });
}

export function useAddArea() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload: { id: string; area: LocationArea }) => {
      const { data } = await apiClient.post<SeedingLocation>(
        `/locations/${payload.id}/areas`,
        payload.area,
      );
      return data;
    },
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: locationKeys.all }),
  });
}

export function useUpdateArea() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload: {
      id: string;
      areaName: string;
      patch: Partial<LocationArea>;
    }) => {
      // areaName goes in the body — names like "Galleria/Uptown" or
      // "Power & Light District" are unsafe as path segments.
      const { data } = await apiClient.patch<SeedingLocation>(
        `/locations/${payload.id}/areas`,
        { areaName: payload.areaName, patch: payload.patch },
      );
      return data;
    },
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: locationKeys.all }),
  });
}

export function useDeleteArea() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload: { id: string; areaName: string }) => {
      // POST + body instead of DELETE + path-param; DELETE-with-body
      // is unreliable across HTTP clients and the slash-in-name issue
      // is the same one we just dodged above.
      const { data } = await apiClient.post<SeedingLocation>(
        `/locations/${payload.id}/areas/remove`,
        { areaName: payload.areaName },
      );
      return data;
    },
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: locationKeys.all }),
  });
}

export const US_STATES: { code: string; name: string }[] = [
  { code: 'AL', name: 'Alabama' },
  { code: 'AK', name: 'Alaska' },
  { code: 'AZ', name: 'Arizona' },
  { code: 'AR', name: 'Arkansas' },
  { code: 'CA', name: 'California' },
  { code: 'CO', name: 'Colorado' },
  { code: 'CT', name: 'Connecticut' },
  { code: 'DE', name: 'Delaware' },
  { code: 'DC', name: 'District of Columbia' },
  { code: 'FL', name: 'Florida' },
  { code: 'GA', name: 'Georgia' },
  { code: 'HI', name: 'Hawaii' },
  { code: 'ID', name: 'Idaho' },
  { code: 'IL', name: 'Illinois' },
  { code: 'IN', name: 'Indiana' },
  { code: 'IA', name: 'Iowa' },
  { code: 'KS', name: 'Kansas' },
  { code: 'KY', name: 'Kentucky' },
  { code: 'LA', name: 'Louisiana' },
  { code: 'ME', name: 'Maine' },
  { code: 'MD', name: 'Maryland' },
  { code: 'MA', name: 'Massachusetts' },
  { code: 'MI', name: 'Michigan' },
  { code: 'MN', name: 'Minnesota' },
  { code: 'MS', name: 'Mississippi' },
  { code: 'MO', name: 'Missouri' },
  { code: 'MT', name: 'Montana' },
  { code: 'NE', name: 'Nebraska' },
  { code: 'NV', name: 'Nevada' },
  { code: 'NH', name: 'New Hampshire' },
  { code: 'NJ', name: 'New Jersey' },
  { code: 'NM', name: 'New Mexico' },
  { code: 'NY', name: 'New York' },
  { code: 'NC', name: 'North Carolina' },
  { code: 'ND', name: 'North Dakota' },
  { code: 'OH', name: 'Ohio' },
  { code: 'OK', name: 'Oklahoma' },
  { code: 'OR', name: 'Oregon' },
  { code: 'PA', name: 'Pennsylvania' },
  { code: 'RI', name: 'Rhode Island' },
  { code: 'SC', name: 'South Carolina' },
  { code: 'SD', name: 'South Dakota' },
  { code: 'TN', name: 'Tennessee' },
  { code: 'TX', name: 'Texas' },
  { code: 'UT', name: 'Utah' },
  { code: 'VT', name: 'Vermont' },
  { code: 'VA', name: 'Virginia' },
  { code: 'WA', name: 'Washington' },
  { code: 'WV', name: 'West Virginia' },
  { code: 'WI', name: 'Wisconsin' },
  { code: 'WY', name: 'Wyoming' },
];
