'use client';

import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type OnChangeFn,
  type Row,
  type SortingState,
  type VisibilityState,
} from '@tanstack/react-table';
import { Columns3, SearchX } from 'lucide-react';
import { useId, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';

import { ErrorState } from '@/components/app/error-state';
import { EmptyState } from '@/components/app/states';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';

/** Cursor pagination controls ("Load more" + page size). `useCursorList().pagination` fits as-is. */
export interface DataTablePagination {
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => void;
  pageSize?: number;
  /** Shows a page-size select when provided. */
  onPageSizeChange?: (size: number) => void;
  pageSizeOptions?: readonly number[];
}

export interface DataTableProps<TData> {
  /** TanStack column defs. Use `meta.align: "right"` for amounts, `meta.label` for the view menu. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- columns mix value types
  columns: ColumnDef<TData, any>[];
  data: readonly TData[] | undefined;
  /** Stable row id (defaults to `row.id` when present, else the index). */
  getRowId?: (row: TData, index: number) => string;
  /** First load → skeleton rows. */
  isLoading?: boolean;
  /** Background refetch → subtle progress hint. */
  isFetching?: boolean;
  /** Load error (shown instead of rows when there is no data). */
  error?: unknown;
  onRetry?: () => void;
  pagination?: DataTablePagination;
  /** Server-driven sorting: pass state + setter (see `useTableSort`). Omit to disable sorting. */
  sorting?: SortingState;
  onSortingChange?: OnChangeFn<SortingState>;
  /** Adds a "Columns" menu to toggle hideable columns. */
  enableColumnVisibility?: boolean;
  /** Initially hidden columns, e.g. `{ createdAt: false }`. */
  initialColumnVisibility?: VisibilityState;
  /** Filters/search shown above the table (left); the view menu sits on the right. */
  toolbar?: ReactNode;
  /** Rendered when there are no rows (defaults to a generic "No results"). */
  emptyState?: ReactNode;
  /** Makes rows clickable (and keyboard-activatable with Enter). Inner links/buttons keep working. */
  onRowClick?: (row: TData) => void;
  /** Tooltip / accessible name for a clickable row or card, e.g. `(r) => \`Open reward ${r.id}\``. */
  rowLabel?: (row: TData) => string;
  /**
   * Mobile fallback: below the `md` breakpoint rows render as cards via this function instead of
   * a horizontally scrolling table.
   */
  renderCard?: (row: TData) => ReactNode;
  skeletonRows?: number;
  /** Visually hidden table caption (describes the table for screen readers). */
  caption?: string;
  className?: string;
}

const DEFAULT_PAGE_SIZES = [10, 25, 50, 100] as const;
const EMPTY: never[] = [];
const INTERACTIVE =
  'a,button,input,select,textarea,label,[role=menuitem],[role=checkbox],[data-row-click-ignore]';

function alignClass(align: 'left' | 'center' | 'right' | undefined): string | undefined {
  if (align === 'right') return 'text-right [&>*]:ml-auto';
  if (align === 'center') return 'text-center [&>*]:mx-auto';
  return undefined;
}

function defaultRowId<TData>(row: TData, index: number): string {
  const id = (row as { id?: unknown } | null)?.id;
  return typeof id === 'string' || typeof id === 'number' ? String(id) : String(index);
}

/**
 * Data table for server-driven lists: cursor pagination ("Load more"), server sorting, column
 * visibility, skeleton/empty/error states, clickable rows and a card layout on mobile.
 */
export function DataTable<TData>({
  columns,
  data,
  getRowId = defaultRowId,
  isLoading = false,
  isFetching = false,
  error,
  onRetry,
  pagination,
  sorting,
  onSortingChange,
  enableColumnVisibility = false,
  initialColumnVisibility,
  toolbar,
  emptyState,
  onRowClick,
  rowLabel,
  renderCard,
  skeletonRows = 6,
  caption,
  className,
}: DataTableProps<TData>) {
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>(
    initialColumnVisibility ?? {},
  );
  const pageSizeLabelId = useId();
  const rows = (data ?? EMPTY) as TData[];

  // TanStack Table returns new functions every render; that's expected here.
  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable({
    data: rows,
    columns,
    getRowId,
    getCoreRowModel: getCoreRowModel(),
    manualSorting: true,
    manualPagination: true,
    enableSorting: Boolean(onSortingChange),
    enableSortingRemoval: true,
    state: { sorting: sorting ?? [], columnVisibility },
    onSortingChange,
    onColumnVisibilityChange: setColumnVisibility,
  });

  const visibleColumnCount = table.getVisibleLeafColumns().length || 1;
  const hasRows = rows.length > 0;
  const showError = Boolean(error) && !hasRows && !isLoading;
  const showEmpty = !isLoading && !showError && !hasRows;
  const hideableColumns = table.getAllLeafColumns().filter((column) => column.getCanHide());

  const activateRow = (row: Row<TData>, event: MouseEvent | KeyboardEvent) => {
    if (!onRowClick) return;
    const target = event.target as HTMLElement;
    if (target.closest(INTERACTIVE) && target.closest(INTERACTIVE) !== event.currentTarget) return;
    onRowClick(row.original);
  };

  // Rows stay semantic table rows; put a real <Link> in the primary cell for screen-reader users.
  const rowInteractionProps = (row: Row<TData>) =>
    onRowClick
      ? {
          tabIndex: 0,
          title: rowLabel?.(row.original),
          className:
            'cursor-pointer focus-visible:bg-muted/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
          onClick: (event: MouseEvent) => activateRow(row, event),
          onKeyDown: (event: KeyboardEvent) => {
            if (event.key === 'Enter' && event.currentTarget === event.target) {
              event.preventDefault();
              activateRow(row, event);
            }
          },
        }
      : {};

  const emptyNode = emptyState ?? (
    <EmptyState
      variant="plain"
      size="sm"
      icon={SearchX}
      title="No results"
      description="Nothing matches the current filters."
    />
  );

  return (
    <div className={cn('space-y-3', className)} data-slot="data-table">
      {toolbar || (enableColumnVisibility && hideableColumns.length > 0) ? (
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{toolbar}</div>
          {enableColumnVisibility && hideableColumns.length > 0 ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="hidden md:inline-flex">
                  <Columns3 aria-hidden />
                  Columns
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuLabel>Show columns</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {hideableColumns.map((column) => (
                  <DropdownMenuCheckboxItem
                    key={column.id}
                    checked={column.getIsVisible()}
                    onCheckedChange={(value) => column.toggleVisibility(Boolean(value))}
                    onSelect={(event) => event.preventDefault()}
                  >
                    {column.columnDef.meta?.label ??
                      (typeof column.columnDef.header === 'string'
                        ? column.columnDef.header
                        : column.id)}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      ) : null}

      <Card
        className={cn('relative gap-0 py-0', renderCard && 'hidden md:flex')}
        aria-busy={isLoading || isFetching || undefined}
      >
        {isFetching && hasRows ? (
          <div className="absolute inset-x-0 top-0 h-0.5 animate-pulse bg-primary/60" aria-hidden />
        ) : null}
        <Table>
          {caption ? <caption className="sr-only">{caption}</caption> : null}
          <TableHeader className="bg-muted/40">
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id} className="hover:bg-transparent">
                {headerGroup.headers.map((header) => {
                  const meta = header.column.columnDef.meta;
                  const sorted = header.column.getIsSorted();
                  return (
                    <TableHead
                      key={header.id}
                      colSpan={header.colSpan}
                      aria-sort={
                        sorted === 'asc'
                          ? 'ascending'
                          : sorted === 'desc'
                            ? 'descending'
                            : undefined
                      }
                      className={cn(
                        'h-10 px-4 text-xs font-medium tracking-wide text-muted-foreground',
                        alignClass(meta?.align),
                        meta?.headerClassName,
                      )}
                    >
                      {header.isPlaceholder
                        ? null
                        : flexRender(header.column.columnDef.header, header.getContext())}
                    </TableHead>
                  );
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {isLoading && !hasRows ? (
              Array.from({ length: skeletonRows }, (_, r) => (
                <TableRow key={`skeleton-${r}`} className="hover:bg-transparent" aria-hidden>
                  {Array.from({ length: visibleColumnCount }, (_, c) => (
                    <TableCell key={c} className="px-4 py-3">
                      <Skeleton
                        className={cn(
                          'h-4',
                          (r + c) % 3 === 0 ? 'w-3/4' : (r + c) % 3 === 1 ? 'w-1/2' : 'w-2/3',
                        )}
                      />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : showError ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={visibleColumnCount} className="p-0 whitespace-normal">
                  <ErrorState error={error} onRetry={onRetry} variant="plain" />
                </TableCell>
              </TableRow>
            ) : showEmpty ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={visibleColumnCount} className="p-0 whitespace-normal">
                  {emptyNode}
                </TableCell>
              </TableRow>
            ) : (
              table.getRowModel().rows.map((row) => {
                const interaction = rowInteractionProps(row);
                return (
                  <TableRow key={row.id} {...interaction} className={cn(interaction.className)}>
                    {row.getVisibleCells().map((cell) => {
                      const meta = cell.column.columnDef.meta;
                      return (
                        <TableCell
                          key={cell.id}
                          className={cn(
                            'px-4 py-2.5',
                            alignClass(meta?.align),
                            meta?.cellClassName,
                          )}
                        >
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </TableCell>
                      );
                    })}
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </Card>

      {renderCard ? (
        <div className="md:hidden" aria-busy={isLoading || undefined}>
          {isLoading && !hasRows ? (
            <ul className="space-y-2" aria-hidden>
              {Array.from({ length: Math.min(skeletonRows, 4) }, (_, i) => (
                <li key={i}>
                  <Card size="sm" className="gap-2 px-3">
                    <Skeleton className="h-4 w-2/3" />
                    <Skeleton className="h-4 w-1/2" />
                  </Card>
                </li>
              ))}
            </ul>
          ) : showError ? (
            <ErrorState error={error} onRetry={onRetry} />
          ) : showEmpty ? (
            <Card className="py-0">{emptyNode}</Card>
          ) : (
            <ul className="space-y-2">
              {table.getRowModel().rows.map((row) => {
                const interaction = rowInteractionProps(row);
                return (
                  <li key={row.id}>
                    <Card
                      size="sm"
                      {...interaction}
                      aria-label={onRowClick ? rowLabel?.(row.original) : undefined}
                      className={cn(
                        'px-3',
                        onRowClick && 'transition-colors hover:bg-muted/40',
                        interaction.className,
                      )}
                    >
                      {renderCard(row.original)}
                    </Card>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}

      {pagination && (hasRows || pagination.onPageSizeChange) && !showError ? (
        <div className="flex flex-col-reverse items-center justify-between gap-3 sm:flex-row">
          <p className="text-xs text-muted-foreground tabular-nums" aria-live="polite">
            {hasRows ? `Showing ${rows.length} ${rows.length === 1 ? 'row' : 'rows'}` : ''}
            {hasRows && !pagination.hasNextPage ? ' · end of list' : ''}
          </p>
          <div className="flex items-center gap-3">
            {pagination.onPageSizeChange ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span id={pageSizeLabelId}>Rows per page</span>
                <Select
                  value={String(pagination.pageSize ?? DEFAULT_PAGE_SIZES[1])}
                  onValueChange={(value) => pagination.onPageSizeChange?.(Number(value))}
                >
                  <SelectTrigger size="sm" className="w-18" aria-labelledby={pageSizeLabelId}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent align="end">
                    {(pagination.pageSizeOptions ?? DEFAULT_PAGE_SIZES).map((size) => (
                      <SelectItem key={size} value={String(size)}>
                        {size}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}
            {pagination.hasNextPage ? (
              <Button
                variant="outline"
                size="sm"
                onClick={pagination.fetchNextPage}
                disabled={pagination.isFetchingNextPage}
              >
                {pagination.isFetchingNextPage ? <Spinner aria-hidden /> : null}
                {pagination.isFetchingNextPage ? 'Loading…' : 'Load more'}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
