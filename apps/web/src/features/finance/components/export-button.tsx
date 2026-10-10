'use client';

import { Download } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { getErrorMessage, type QueryParams } from '@/lib/api-client';

import { downloadCsv } from '../lib';

export interface ExportCsvButtonProps {
  /** API path relative to /api/v1, e.g. "/admin/rewards/export.csv". */
  path: string;
  /** Current filters (the export uses the same ones as the table). */
  query: QueryParams;
  fallbackName: string;
  label?: string;
}

/** Downloads a CSV export of the current filters; shows API errors as a toast. */
export function ExportCsvButton({ path, query, fallbackName, label = 'Export CSV' }: ExportCsvButtonProps) {
  const [pending, setPending] = useState(false);
  return (
    <Button
      variant="outline"
      disabled={pending}
      onClick={async () => {
        setPending(true);
        try {
          await downloadCsv(path, query, fallbackName);
        } catch (error) {
          toast.error('Export failed', { description: getErrorMessage(error) });
        } finally {
          setPending(false);
        }
      }}
    >
      {pending ? <Spinner aria-hidden /> : <Download aria-hidden />}
      {pending ? 'Preparing…' : label}
    </Button>
  );
}
