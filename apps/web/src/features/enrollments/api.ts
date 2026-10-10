'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ActivateEnrollmentInput, AdminEnrollmentDto, MyEnrollmentDto } from '@app/shared';

import { api } from '@/lib/api-client';
import { queryKeys } from '@/lib/query-keys';

/** Cursor list paths (use with `useCursorList`). */
export const ADMIN_ENROLLMENTS_PATH = '/admin/enrollments';
export const MY_ENROLLMENTS_PATH = '/users/me/enrollments';

function useInvalidateEnrollments() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['admin', 'enrollments'] }),
      // Program screens show enrollment counts.
      queryClient.invalidateQueries({ queryKey: ['admin', 'program'] }),
      queryClient.invalidateQueries({ queryKey: ['admin', 'programs'] }),
      queryClient.invalidateQueries({ queryKey: queryKeys.enrollments.all }),
      queryClient.invalidateQueries({ queryKey: queryKeys.programs.all }),
    ]);
}

export function useActivateEnrollment() {
  const invalidate = useInvalidateEnrollments();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: ActivateEnrollmentInput }) =>
      api.post<AdminEnrollmentDto>(`${ADMIN_ENROLLMENTS_PATH}/${id}/activate`, input),
    onSuccess: () => void invalidate(),
  });
}

export function useRejectEnrollment() {
  const invalidate = useInvalidateEnrollments();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      api.post<AdminEnrollmentDto>(`${ADMIN_ENROLLMENTS_PATH}/${id}/reject`, { reason }),
    onSuccess: () => void invalidate(),
  });
}

export function useAdminCancelEnrollment() {
  const invalidate = useInvalidateEnrollments();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      api.post<AdminEnrollmentDto>(`${ADMIN_ENROLLMENTS_PATH}/${id}/cancel`, { reason }),
    onSuccess: () => void invalidate(),
  });
}

/** Member cancels their own enrollment. */
export function useCancelMyEnrollment() {
  const invalidate = useInvalidateEnrollments();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) =>
      api.post<MyEnrollmentDto>(`${MY_ENROLLMENTS_PATH}/${id}/cancel`, reason ? { reason } : {}),
    onSuccess: () => void invalidate(),
  });
}
