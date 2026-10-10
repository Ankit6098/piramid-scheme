'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { CreateOfferingInput, OfferingDto, UpdateOfferingInput } from '@app/shared';

import { api } from '@/lib/api-client';

/** Cursor list path (use with `useCursorList` + `queryKeys.admin.offerings(params)`). */
export const OFFERINGS_PATH = '/admin/offerings';

function useInvalidateOfferings() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['admin', 'offerings'] }),
      queryClient.invalidateQueries({ queryKey: ['admin', 'offering'] }),
      // Program screens show the offering name/status.
      queryClient.invalidateQueries({ queryKey: ['admin', 'programs'] }),
      queryClient.invalidateQueries({ queryKey: ['admin', 'program'] }),
    ]);
}

export function useCreateOffering() {
  const invalidate = useInvalidateOfferings();
  return useMutation({
    mutationFn: (input: CreateOfferingInput) => api.post<OfferingDto>(OFFERINGS_PATH, input),
    onSuccess: () => void invalidate(),
  });
}

export function useUpdateOffering() {
  const invalidate = useInvalidateOfferings();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateOfferingInput }) =>
      api.patch<OfferingDto>(`${OFFERINGS_PATH}/${id}`, input),
    onSuccess: () => void invalidate(),
  });
}

export function useApproveOffering() {
  const invalidate = useInvalidateOfferings();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) =>
      api.post<OfferingDto>(`${OFFERINGS_PATH}/${id}/approve`, reason ? { reason } : {}),
    onSuccess: () => void invalidate(),
  });
}

export function useDeactivateOffering() {
  const invalidate = useInvalidateOfferings();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      api.post<OfferingDto>(`${OFFERINGS_PATH}/${id}/deactivate`, { reason }),
    onSuccess: () => void invalidate(),
  });
}

export function useDeleteOffering() {
  const invalidate = useInvalidateOfferings();
  return useMutation({
    mutationFn: (id: string) => api.delete(`${OFFERINGS_PATH}/${id}`),
    onSuccess: () => void invalidate(),
  });
}

