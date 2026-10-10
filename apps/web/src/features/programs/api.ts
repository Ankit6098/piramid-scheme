'use client';

import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AdminProgramDetailDto,
  CreateProgramInput,
  CreateProgramOptionInput,
  MemberProgramDetailDto,
  MyEnrollmentDto,
  OfferingDto,
  ProgramAdminCandidateDto,
  ProgramAdminDto,
  ProgramLifecycleAction,
  ProgramOptionDto,
  UpdateProgramInput,
  UpdateProgramOptionInput,
} from '@app/shared';

import { api } from '@/lib/api-client';
import { queryKeys } from '@/lib/query-keys';

import { programKeys } from './query-keys';

export const ADMIN_PROGRAMS_PATH = '/admin/programs';
export const MEMBER_PROGRAMS_PATH = '/programs';

// ─── admin: reads ───────────────────────────────────────────────────────────

export function adminProgramQueryOptions(id: string) {
  return queryOptions({
    queryKey: queryKeys.admin.program(id),
    queryFn: ({ signal }) => api.get<AdminProgramDetailDto>(`${ADMIN_PROGRAMS_PATH}/${encodeURIComponent(id)}`, { signal }),
  });
}

/** Program detail (options, policy summary, counts, timeline). Shared by every program tab. */
export function useAdminProgram(id: string) {
  return useQuery({ ...adminProgramQueryOptions(id), enabled: Boolean(id) });
}

/** Offerings for the program form (newest 100; `programs:read` may list offerings). */
export function useOfferingChoices() {
  return useQuery({
    queryKey: programKeys.offeringChoices(),
    queryFn: async ({ signal }) => {
      const page = await api.getPage<OfferingDto>('/admin/offerings', { query: { limit: 100 }, signal });
      return page.data;
    },
    staleTime: 60_000,
  });
}

export function useProgramAdmins(programId: string) {
  return useQuery({
    queryKey: programKeys.admins(programId),
    queryFn: ({ signal }) => api.get<ProgramAdminDto[]>(`${ADMIN_PROGRAMS_PATH}/${programId}/admins`, { signal }),
  });
}

export function useProgramAdminCandidates(programId: string, enabled: boolean) {
  return useQuery({
    queryKey: programKeys.adminCandidates(programId),
    queryFn: ({ signal }) => api.get<ProgramAdminCandidateDto[]>(`${ADMIN_PROGRAMS_PATH}/${programId}/admins/candidates`, { signal }),
    enabled,
  });
}

// ─── admin: writes ──────────────────────────────────────────────────────────

function useInvalidatePrograms() {
  const queryClient = useQueryClient();
  return (id?: string) =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['admin', 'programs'] }),
      id ? queryClient.invalidateQueries({ queryKey: queryKeys.admin.program(id) }) : Promise.resolve(),
      // Member catalogue and enrollment screens show program data too.
      queryClient.invalidateQueries({ queryKey: queryKeys.programs.all }),
    ]);
}

export function useCreateProgram() {
  const queryClient = useQueryClient();
  const invalidate = useInvalidatePrograms();
  return useMutation({
    mutationFn: (input: CreateProgramInput) => api.post<AdminProgramDetailDto>(ADMIN_PROGRAMS_PATH, input),
    onSuccess: (program) => {
      queryClient.setQueryData(queryKeys.admin.program(program.id), program);
      void invalidate();
    },
  });
}

export function useUpdateProgram(id: string) {
  const queryClient = useQueryClient();
  const invalidate = useInvalidatePrograms();
  return useMutation({
    mutationFn: (input: UpdateProgramInput) => api.patch<AdminProgramDetailDto>(`${ADMIN_PROGRAMS_PATH}/${id}`, input),
    onSuccess: (program) => {
      queryClient.setQueryData(queryKeys.admin.program(id), program);
      void invalidate();
    },
  });
}

export function useDeleteProgram() {
  const queryClient = useQueryClient();
  const invalidate = useInvalidatePrograms();
  return useMutation({
    mutationFn: (id: string) => api.delete(`${ADMIN_PROGRAMS_PATH}/${id}`),
    onSuccess: (_data, id) => {
      queryClient.removeQueries({ queryKey: queryKeys.admin.program(id) });
      void invalidate();
    },
  });
}

export interface LifecycleVariables {
  action: ProgramLifecycleAction;
  expectedVersion?: number;
  reason?: string;
}

/** publish / pause / resume / complete / archive. */
export function useProgramLifecycle(id: string) {
  const queryClient = useQueryClient();
  const invalidate = useInvalidatePrograms();
  return useMutation({
    mutationFn: ({ action, ...body }: LifecycleVariables) =>
      api.post<AdminProgramDetailDto>(`${ADMIN_PROGRAMS_PATH}/${id}/${action}`, body),
    onSuccess: (program) => {
      queryClient.setQueryData(queryKeys.admin.program(id), program);
      void invalidate();
    },
  });
}

export function useCreateOption(programId: string) {
  const invalidate = useInvalidatePrograms();
  return useMutation({
    mutationFn: (input: CreateProgramOptionInput) => api.post<ProgramOptionDto>(`${ADMIN_PROGRAMS_PATH}/${programId}/options`, input),
    onSuccess: () => void invalidate(programId),
  });
}

export function useUpdateOption(programId: string) {
  const invalidate = useInvalidatePrograms();
  return useMutation({
    mutationFn: ({ optionId, input }: { optionId: string; input: UpdateProgramOptionInput }) =>
      api.patch<ProgramOptionDto>(`${ADMIN_PROGRAMS_PATH}/${programId}/options/${optionId}`, input),
    onSuccess: () => void invalidate(programId),
  });
}

export function useSetOptionActive(programId: string) {
  const invalidate = useInvalidatePrograms();
  return useMutation({
    mutationFn: ({ optionId, active }: { optionId: string; active: boolean }) =>
      api.post<ProgramOptionDto>(`${ADMIN_PROGRAMS_PATH}/${programId}/options/${optionId}/${active ? 'activate' : 'deactivate'}`, {}),
    onSuccess: () => void invalidate(programId),
  });
}

export function useSetProgramAdmins(programId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { userIds: string[]; reason?: string }) =>
      api.put<ProgramAdminDto[]>(`${ADMIN_PROGRAMS_PATH}/${programId}/admins`, input),
    onSuccess: (admins) => {
      queryClient.setQueryData(programKeys.admins(programId), admins);
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.program(programId) });
    },
  });
}

// ─── member catalogue ───────────────────────────────────────────────────────

export function memberProgramQueryOptions(idOrCode: string) {
  return queryOptions({
    queryKey: queryKeys.programs.detail(idOrCode),
    queryFn: ({ signal }) => api.get<MemberProgramDetailDto>(`${MEMBER_PROGRAMS_PATH}/${encodeURIComponent(idOrCode)}`, { signal }),
  });
}

export function useMemberProgram(idOrCode: string) {
  return useQuery({ ...memberProgramQueryOptions(idOrCode), enabled: Boolean(idOrCode) });
}

/** POST /programs/:id/enrollments — refreshes the catalogue and the member's enrollments. */
export function useEnroll(programId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { optionId: string; acceptTerms: true; termsVersion?: string }) =>
      api.post<MyEnrollmentDto>(`${MEMBER_PROGRAMS_PATH}/${programId}/enrollments`, input),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.programs.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.enrollments.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.dashboard.all }),
      ]),
  });
}

