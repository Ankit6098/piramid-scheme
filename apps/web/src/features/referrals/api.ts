'use client';

import { queryOptions, useMutation, useQuery } from '@tanstack/react-query';
import type {
  DirectReferralDto,
  MemberStatusBucket,
  MyParentResponse,
  ReferralCodeResponse,
  ValidateReferralCodeResponse,
} from '@app/shared';

import { useCursorList } from '@/components/app/data-table';
import { api } from '@/lib/api-client';
import { queryKeys } from '@/lib/query-keys';

export function referralCodeQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.referrals.code(),
    queryFn: ({ signal }) => api.get<ReferralCodeResponse>('/users/me/referral-code', { signal }),
    staleTime: 5 * 60_000,
  });
}

/** The member's own referral code + public registration link. */
export function useReferralCode() {
  return useQuery(referralCodeQueryOptions());
}

/** Sponsor + upline (null for a member without a sponsor). */
export function useMyParent() {
  return useQuery({
    queryKey: queryKeys.referrals.sponsor(),
    queryFn: ({ signal }) => api.get<MyParentResponse | null>('/users/me/parent', { signal }),
  });
}

export interface DirectReferralFilters {
  status?: MemberStatusBucket;
}

/** Direct referrals, newest first (cursor list for `<DataTable>`). */
export function useDirectReferrals(filters: DirectReferralFilters) {
  return useCursorList<DirectReferralDto>({
    queryKey: queryKeys.referrals.team({ kind: 'direct', ...filters }),
    path: '/users/me/referrals',
    query: { status: filters.status },
    pageSize: 25,
  });
}

/** Registration form helper: checks a referral code (public, rate limited). */
export function useValidateReferralCode() {
  return useMutation({
    mutationFn: (code: string) => api.post<ValidateReferralCodeResponse>('/referrals/validate', { code }),
  });
}
