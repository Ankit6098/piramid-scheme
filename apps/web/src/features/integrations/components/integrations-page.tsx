'use client';

import { FilterX, PlugZap, Plus, ShieldCheck, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { ApiClientDto, ApiClientStatus } from '@app/shared';

import { DataTable, useCursorList } from '@/components/app/data-table';
import { PageHeader } from '@/components/app/page-header';
import { EmptyState } from '@/components/app/states';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useSalePrograms } from '@/features/events/api';

import { API_CLIENTS_PATH } from '../api';
import { API_CLIENT_STATUS_OPTIONS } from '../labels';
import { integrationKeys } from '../query-keys';
import { ApiClientCard, apiClientColumns } from './api-client-columns';
import { CreateApiClientDialog } from './create-api-client-dialog';
import { SalesApiUsageCard } from './sales-api-usage-card';

const ALL = 'all';

/** /admin/integrations — API clients (machine keys) that submit sales for one program each. */
export function IntegrationsPage() {
  const [programId, setProgramId] = useState<string | undefined>();
  const [status, setStatus] = useState<ApiClientStatus | undefined>();
  const programsQuery = useSalePrograms();
  const programs = programsQuery.data;

  const query = useMemo(() => ({ programId, status }), [programId, status]);
  const list = useCursorList<ApiClientDto>({
    queryKey: integrationKeys.clients(query),
    path: API_CLIENTS_PATH,
    query,
  });
  const filtered = Boolean(programId || status);

  // New `key` per open → the dialog always starts empty and never keeps a previous key.
  const [createOpen, setCreateOpen] = useState(false);
  const [createSession, setCreateSession] = useState(0);
  function openCreate() {
    setCreateSession((n) => n + 1);
    setCreateOpen(true);
  }

  const newButton = (
    <Button onClick={openCreate}>
      <Plus aria-hidden />
      New API client
    </Button>
  );

  const toolbar = (
    <>
      <Select
        value={programId ?? ALL}
        onValueChange={(value) => setProgramId(value === ALL ? undefined : value)}
        disabled={programsQuery.isPending}
      >
        <SelectTrigger size="sm" aria-label="Program" className="w-full sm:w-56">
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper">
          <SelectItem value={ALL}>All programs</SelectItem>
          {(programs ?? []).map((program) => (
            <SelectItem key={program.id} value={program.id}>
              {program.name} · {program.code}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={status ?? ALL}
        onValueChange={(value) => setStatus(value === ALL ? undefined : (value as ApiClientStatus))}
      >
        <SelectTrigger size="sm" aria-label="Status" className="w-full sm:w-40">
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper">
          <SelectItem value={ALL}>All statuses</SelectItem>
          {API_CLIENT_STATUS_OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {filtered ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setProgramId(undefined);
            setStatus(undefined);
          }}
        >
          <X aria-hidden />
          Reset filters
        </Button>
      ) : null}
    </>
  );

  const emptyState = filtered ? (
    <EmptyState
      variant="plain"
      size="sm"
      icon={FilterX}
      title="No API clients match these filters"
    />
  ) : (
    <EmptyState
      variant="plain"
      icon={PlugZap}
      title="No API clients yet"
      description="Create a client to let your sales system submit qualifying sales for a program automatically."
      action={newButton}
    />
  );

  return (
    <div>
      <PageHeader
        title="Integrations"
        description="API clients let your sales systems submit qualifying sales automatically. Each client submits sales for exactly one program."
        actions={newButton}
      />

      <div className="space-y-6">
        <Alert role="note">
          <ShieldCheck aria-hidden />
          <AlertTitle>Keys are shown once</AlertTitle>
          <AlertDescription>
            A key is displayed only when the client is created and is stored as a hash. If a key is
            lost or may have been exposed, revoke the client immediately and create a new one.
          </AlertDescription>
        </Alert>

        <section aria-labelledby="api-clients-heading" className="space-y-3">
          <h2 id="api-clients-heading" className="sr-only">
            API clients
          </h2>
          <DataTable
            columns={apiClientColumns}
            data={list.rows}
            isLoading={list.isLoading}
            isFetching={list.isFetching}
            error={list.error}
            onRetry={list.refetch}
            pagination={list.pagination}
            toolbar={toolbar}
            emptyState={emptyState}
            renderCard={(client) => <ApiClientCard client={client} />}
            caption="API clients, newest first"
          />
        </section>

        <SalesApiUsageCard />
      </div>

      <CreateApiClientDialog
        key={createSession}
        open={createOpen}
        onOpenChange={setCreateOpen}
        programs={programs}
        programsLoading={programsQuery.isPending}
        programsError={programsQuery.error}
        onRetryPrograms={() => void programsQuery.refetch()}
      />
    </div>
  );
}
