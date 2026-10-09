'use client';

import type { Column } from '@tanstack/react-table';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface DataTableColumnHeaderProps<TData, TValue> {
  column: Column<TData, TValue>;
  title: string;
  className?: string;
}

/**
 * Sortable header button (server-driven sorting: it only changes the table's `sorting` state,
 * which you pass to the API). Renders plain text for non-sortable columns.
 *
 * @example header: ({ column }) => <DataTableColumnHeader column={column} title="Created" />
 */
export function DataTableColumnHeader<TData, TValue>({
  column,
  title,
  className,
}: DataTableColumnHeaderProps<TData, TValue>) {
  if (!column.getCanSort()) return <span className={className}>{title}</span>;
  const sorted = column.getIsSorted();
  const Icon = sorted === 'asc' ? ArrowUp : sorted === 'desc' ? ArrowDown : ArrowUpDown;
  const next = sorted === 'asc' ? 'descending' : 'ascending';
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={cn('-ml-2 h-7 px-2 font-medium data-[sorted=true]:text-foreground', className)}
      data-sorted={sorted ? true : undefined}
      onClick={() => column.toggleSorting(sorted === 'asc')}
      aria-label={`${title}: sort ${next}`}
    >
      {title}
      <Icon className={cn('size-3.5', !sorted && 'text-muted-foreground/70')} aria-hidden />
    </Button>
  );
}
