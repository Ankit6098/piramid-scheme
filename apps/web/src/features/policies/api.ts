'use client';

/**
 * Data hooks for the reward-policies admin page (contract: slice 4 policies endpoints). All keys
 * live under `policyKeys.all`; every mutation invalidates that root.
 */
import {
  keepPreviousData,
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import type {
  CreatePolicyDraftInput,
  DeletedPolicyDto,
  DryRunPolicyInput,
  DryRunResultDto,
  PolicyContextDto,
  PolicyValidationResultDto,
  PolicyVersionDto,
  PolicyVersionSummaryDto,
  PublishPolicyResultDto,
  RetirePolicyResultDto,
  UpdatePolicyDraftInput,
  ValidatePolicyInput,
} from '@app/shared';

import { useCursorList } from '@/components/app/data-table';
import { api } from '@/lib/api-client';

import { policyKeys } from './query-keys';

/** Versions per page in the timeline (programs rarely have more; "Load older versions" fetches the rest). */
export const POLICY_LIST_PAGE_SIZE = 50;

const seg = (value: string) => encodeURIComponent(value);

// ─── Queries ─────────────────────────────────────────────────────────────────

export function policyContextQueryOptions(programId: string) {
  return queryOptions({
    queryKey: policyKeys.context(programId),
    queryFn: ({ signal }) =>
      api.get<PolicyContextDto>(`/admin/programs/${seg(programId)}/policy-context`, { signal }),
  });
}

export function usePolicyContext(programId: string) {
  return useQuery(policyContextQueryOptions(programId));
}

/** All versions of a program, newest first (cursor pages flattened). */
export function usePolicyVersions(programId: string, enabled = true) {
  return useCursorList<PolicyVersionSummaryDto>({
    queryKey: policyKeys.list(programId),
    path: `/admin/programs/${seg(programId)}/policies`,
    pageSize: POLICY_LIST_PAGE_SIZE,
    enabled,
  });
}

export function policyDetailQueryOptions(id: string) {
  return queryOptions({
    queryKey: policyKeys.detail(id),
    queryFn: ({ signal }) => api.get<PolicyVersionDto>(`/admin/policies/${seg(id)}`, { signal }),
  });
}

export function usePolicyVersion(id: string) {
  return useQuery(policyDetailQueryOptions(id));
}

/**
 * Live validation (read-only POST used as a query). `bodyJson` is the serialized
 * `ValidatePolicyInput`; each distinct body is its own cache entry, so out-of-order responses can
 * never overwrite the result for the current input. `null` disables the query.
 */
export function usePolicyValidation(
  policyId: string,
  basedOn: string,
  bodyJson: string | null,
  enabled = true,
) {
  return useQuery({
    queryKey: policyKeys.validation(policyId, basedOn, bodyJson ?? ''),
    queryFn: ({ signal }) =>
      api.post<PolicyValidationResultDto>(
        `/admin/policies/${seg(policyId)}/validate`,
        JSON.parse(bodyJson ?? '{}') as ValidatePolicyInput,
        { signal },
      ),
    enabled: enabled && bodyJson !== null,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
}

// ─── Mutations ───────────────────────────────────────────────────────────────

export function useCreatePolicyDraft(programId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreatePolicyDraftInput) =>
      api.post<PolicyVersionDto>(`/admin/programs/${seg(programId)}/policies`, input),
    onSuccess: (policy) => {
      queryClient.setQueryData(policyKeys.detail(policy.id), policy);
      void queryClient.invalidateQueries({ queryKey: policyKeys.all });
    },
  });
}

/**
 * PATCH a draft. The caller writes the returned version into the detail cache itself (after moving
 * its optimistic-concurrency baseline), so a saved draft never looks "changed elsewhere".
 */
export function useUpdatePolicyDraft(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdatePolicyDraftInput) =>
      api.patch<PolicyVersionDto>(`/admin/policies/${seg(id)}`, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: policyKeys.all,
        predicate: (query) => query.queryKey[1] !== 'detail' || query.queryKey[2] !== id,
      });
    },
  });
}

export function useDeletePolicyDraft(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.delete<DeletedPolicyDto>(`/admin/policies/${seg(id)}`),
    // Awaited: when the caller moves the selection, the timeline no longer lists the deleted draft.
    // Queries of the deleted version itself are not refetched (they would only 404).
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: policyKeys.all,
        predicate: (query) => query.queryKey[2] !== id,
      }),
  });
}

/** One-off validation (publish pre-check with the final `effectiveFrom`). */
export function useValidatePolicy(id: string) {
  return useMutation({
    mutationFn: (input: ValidatePolicyInput) =>
      api.post<PolicyValidationResultDto>(`/admin/policies/${seg(id)}/validate`, input),
  });
}

export function usePublishPolicy(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      effectiveFrom,
      idempotencyKey,
    }: {
      effectiveFrom: string;
      idempotencyKey?: string;
    }) =>
      api.post<PublishPolicyResultDto>(
        `/admin/policies/${seg(id)}/publish`,
        { effectiveFrom },
        { idempotencyKey },
      ),
    onSuccess: (result) => {
      queryClient.setQueryData(policyKeys.detail(result.policy.id), result.policy);
      void queryClient.invalidateQueries({ queryKey: policyKeys.all });
    },
  });
}

export function useRetirePolicy(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ reason, idempotencyKey }: { reason: string; idempotencyKey?: string }) =>
      api.post<RetirePolicyResultDto>(
        `/admin/policies/${seg(id)}/retire`,
        { reason },
        { idempotencyKey },
      ),
    onSuccess: (result) => {
      queryClient.setQueryData(policyKeys.detail(result.policy.id), result.policy);
      void queryClient.invalidateQueries({ queryKey: policyKeys.all });
    },
  });
}

/** Read-only preview with the real calculator (nothing is recorded). */
export function useDryRunPolicy(id: string) {
  return useMutation({
    mutationFn: (input: DryRunPolicyInput) =>
      api.post<DryRunResultDto>(`/admin/policies/${seg(id)}/dry-run`, input),
  });
}
