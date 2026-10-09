'use client';

import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query';
import type { SortingState } from '@tanstack/react-table';
import { useMemo, useState } from 'react';
import { DEFAULT_PAGE_LIMIT } from '@app/shared';

import { api, type QueryParams } from '@/lib/api-client';

import type { DataTablePagination } from './data-table';

export interface UseCursorListOptions {
  /** Base query key from `queryKeys` — include your filters in it (page size is appended). */
  queryKey: readonly unknown[];
  /** API path relative to /api/v1, e.g. "/admin/rewards". */
  path: string;
  /** Filters/sort params sent with every page (`cursor` and `limit` are added). */
  query?: QueryParams;
  pageSize?: number;
  enabled?: boolean;
}

/**
 * Cursor-paginated list (`ApiPage<T>`) as an infinite query, flattened for `<DataTable>`.
 *
 * @example
 *   const list = useCursorList<RewardRow>({ queryKey: queryKeys.admin.rewards(filters), path: "/admin/rewards", query: filters });
 *   <DataTable columns={columns} data={list.rows} isLoading={list.isLoading} error={list.error}
 *              onRetry={list.refetch} pagination={list.pagination} />
 */
export function useCursorList<T>({
  queryKey,
  path,
  query,
  pageSize: initialPageSize = DEFAULT_PAGE_LIMIT,
  enabled = true,
}: UseCursorListOptions) {
  const [pageSize, setPageSize] = useState(initialPageSize);

  const result = useInfiniteQuery({
    queryKey: [...queryKey, { limit: pageSize }],
    queryFn: ({ pageParam, signal }) =>
      api.getPage<T>(path, { query: { ...query, cursor: pageParam, limit: pageSize }, signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.page.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
    enabled,
  });

  const rows = useMemo(() => result.data?.pages.flatMap((page) => page.data) ?? [], [result.data]);

  const pagination: DataTablePagination = {
    hasNextPage: result.hasNextPage,
    isFetchingNextPage: result.isFetchingNextPage,
    fetchNextPage: () => void result.fetchNextPage(),
    pageSize,
    onPageSizeChange: setPageSize,
  };

  return {
    rows,
    isLoading: result.isPending,
    isFetching: result.isFetching && !result.isFetchingNextPage,
    error: result.error,
    refetch: () => void result.refetch(),
    pagination,
    query: result,
  };
}

/**
 * Server-side sorting state for `<DataTable sorting onSortingChange>` plus API params.
 * Adjust `sortParams` to the endpoint's convention if it differs from `sort` + `order`.
 */
export function useTableSort(initial?: { id: string; desc?: boolean }) {
  const [sorting, setSorting] = useState<SortingState>(
    initial ? [{ id: initial.id, desc: initial.desc ?? false }] : [],
  );
  const first = sorting[0];
  const sortParams: { sort?: string; order?: 'asc' | 'desc' } = first
    ? { sort: first.id, order: first.desc ? 'desc' : 'asc' }
    : {};
  return { sorting, onSortingChange: setSorting, sortParams };
}
