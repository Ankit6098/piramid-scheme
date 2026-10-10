/**
 * Small finance helpers shared by the rewards, ledger and reconciliation pages.
 */
import { ErrorCode } from '@app/shared';
import type { FinanceAmountUnit } from '@app/shared';

import { ApiError, buildUrl, type QueryParams } from '@/lib/api-client';
import type { AmountFormatOverride } from '@/providers/platform-settings-provider';

/** `<Amount format>` for a row that carries its own unit + currency snapshot. */
export function unitFormat(row: FinanceAmountUnit): AmountFormatOverride {
  return { unit: row.rewardUnit, currencyCode: row.currencyCode, minorUnits: row.currencyMinorUnits };
}

/** Sale amounts are always currency. */
export function currencyFormat(currencyCode: string, minorUnits?: number): AmountFormatOverride {
  return minorUnits === undefined ? { currencyCode } : { currencyCode, minorUnits };
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * `YYYY-MM-DD` filter values (from `<input type="date">`) → ISO instants for the viewer's local
 * day: `from` = local midnight, `to` = the next local midnight (exclusive). Invalid values are dropped.
 */
export function localDayRange(from?: string, to?: string): { from?: string; to?: string } {
  const at = (value: string | undefined, addDays: number) => {
    const m = value ? DATE_ONLY.exec(value) : null;
    if (!m) return undefined;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + addDays);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  };
  return { from: at(from, 0), to: at(to, 1) };
}

/** First 8 characters of an id, for compact display (always with the full id in a title/copy). */
export function shortId(id: string): string {
  return id.slice(0, 8);
}

/**
 * Downloads a CSV export with the session cookie, surfacing API errors (403, validation) as
 * `ApiError` instead of saving an error body as a file.
 */
export async function downloadCsv(path: string, query: QueryParams, fallbackName: string): Promise<void> {
  const response = await fetch(buildUrl(path, query), {
    method: 'GET',
    credentials: 'include',
    cache: 'no-store',
    headers: { Accept: 'text/csv' },
  });
  if (!response.ok) {
    type ErrorBody = { error?: { code?: string; message?: string; details?: unknown; requestId?: string } };
    let body: ErrorBody | null;
    try {
      body = (await response.json()) as ErrorBody;
    } catch {
      body = null;
    }
    throw new ApiError({
      code: body?.error?.code ?? (response.status === 403 ? ErrorCode.Forbidden : ErrorCode.Internal),
      message: body?.error?.message ?? 'The export could not be created. Please try again.',
      status: response.status,
      details: body?.error?.details,
      requestId: body?.error?.requestId,
    });
  }
  const blob = await response.blob();
  const disposition = response.headers.get('content-disposition') ?? '';
  const name = /filename="([^"]+)"/.exec(disposition)?.[1] ?? fallbackName;
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
