'use client';

import { FilterX, Plus, ReceiptText, RefreshCw } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Permission, type SaleEventDetailDto, type SaleEventDto } from '@app/shared';

import { DataTable, useCursorList } from '@/components/app/data-table';
import { Can } from '@/components/app/guards';
import { PageHeader } from '@/components/app/page-header';
import { EmptyState } from '@/components/app/states';
import { Button } from '@/components/ui/button';
import { Sheet } from '@/components/ui/sheet';
import { useBrowserTimeZone } from '@/hooks/use-time-zone';

import { SALE_EVENTS_PATH, useSalePrograms } from '../api';
import { eventKeys } from '../query-keys';
import { hasActiveFilters, toEventListQuery, useEventFilters } from '../use-event-filters';
import { buildEventColumns, EventCard } from './event-columns';
import { EventDetailSheet } from './event-detail-sheet';
import { EventFiltersToolbar } from './event-filters';
import {
  createRecordSaleSession,
  RecordSaleSheetContent,
  type RecordSaleSession,
} from './record-sale-sheet';

/** /admin/events — qualifying sales, their calculation results and rewards. */
export function SalesEventsPage() {
  const { filters, openEventId, setParams, resetFilters, eventHref, openEvent, closeEvent } =
    useEventFilters();
  const programsQuery = useSalePrograms();
  const programs = programsQuery.data;
  const browserZone = useBrowserTimeZone() ?? 'UTC';
  const selectedProgram = programs?.find((p) => p.id === filters.programId);
  // Date filters are days in the selected program's zone (or the viewer's zone for all programs).
  const timeZone = selectedProgram?.timezone ?? browserZone;
  const query = useMemo(() => toEventListQuery(filters, timeZone), [filters, timeZone]);
  const waitForProgramZone =
    Boolean(filters.programId && (filters.from || filters.to)) && programsQuery.isPending;

  const list = useCursorList<SaleEventDto>({
    queryKey: eventKeys.list(query),
    path: SALE_EVENTS_PATH,
    query,
    enabled: !waitForProgramZone,
  });
  const columns = useMemo(() => buildEventColumns({ eventHref }), [eventHref]);
  const filtered = hasActiveFilters(filters);

  // "Record sale" sheet: a new session (fresh form + Idempotency-Key) per open.
  const [recordOpen, setRecordOpen] = useState(false);
  const [recordSession, setRecordSession] = useState<RecordSaleSession | null>(null);

  function openRecordSale(prefill?: SaleEventDetailDto) {
    // Preselect the filtered program when the user may record sales for it.
    const preselect = selectedProgram?.canRecordSales ? selectedProgram.id : undefined;
    setRecordSession(createRecordSaleSession({ programId: prefill ? undefined : preselect, prefill }));
    setRecordOpen(true);
  }

  const recordButton = (
    <Can perm={Permission.EventsWrite}>
      <Button onClick={() => openRecordSale()}>
        <Plus aria-hidden />
        Record sale
      </Button>
    </Can>
  );

  const emptyState = filtered ? (
    <EmptyState
      variant="plain"
      size="sm"
      icon={FilterX}
      title="No sales match these filters"
      description="Search matches an exact external id or customer reference."
      action={
        <Button variant="outline" onClick={resetFilters}>
          Reset filters
        </Button>
      }
    />
  ) : (
    <EmptyState
      variant="plain"
      icon={ReceiptText}
      title="No sales recorded yet"
      description="Sales of approved offerings appear here once they are recorded by an administrator or submitted by an API client."
      action={recordButton}
    />
  );

  return (
    <div>
      <PageHeader
        title="Sales events"
        description="Qualifying sales of approved offerings to end customers, credited to members. Rewards are computed only from these sales — never from sign-ups, referrals or plan payments."
        actions={
          <>
            <Button
              variant="outline"
              size="icon"
              onClick={list.refetch}
              disabled={list.isFetching}
              aria-label="Refresh sales"
              title="Refresh"
            >
              <RefreshCw aria-hidden className={list.isFetching ? 'animate-spin' : undefined} />
            </Button>
            {recordButton}
          </>
        }
      />

      <DataTable
        columns={columns}
        data={list.rows}
        isLoading={list.isLoading}
        isFetching={list.isFetching}
        error={list.error}
        onRetry={list.refetch}
        pagination={list.pagination}
        enableColumnVisibility
        toolbar={
          <EventFiltersToolbar
            filters={filters}
            programs={programs}
            programsLoading={programsQuery.isPending}
            timeZone={timeZone}
            onChange={setParams}
            onReset={resetFilters}
          />
        }
        emptyState={emptyState}
        onRowClick={(row) => openEvent(row.id)}
        rowLabel={(row) => `Open sale ${row.externalId}`}
        renderCard={(row) => <EventCard event={row} href={eventHref(row.id)} />}
        caption="Qualifying sales, newest first"
      />

      <EventDetailSheet
        eventId={openEventId}
        onClose={closeEvent}
        eventHref={eventHref}
        programs={programs}
        onReRecord={(event) => {
          closeEvent();
          openRecordSale(event);
        }}
      />

      <Sheet
        open={recordOpen}
        onOpenChange={(open) => {
          if (!open) setRecordOpen(false);
        }}
      >
        {recordSession ? (
          <RecordSaleSheetContent
            key={recordSession.id}
            session={recordSession}
            open={recordOpen}
            programs={programs}
            programsLoading={programsQuery.isPending}
            programsError={programsQuery.error}
            onRetryPrograms={() => void programsQuery.refetch()}
            onClose={() => setRecordOpen(false)}
            onViewEvent={(id) => {
              setRecordOpen(false);
              openEvent(id);
            }}
          />
        ) : null}
      </Sheet>
    </div>
  );
}
