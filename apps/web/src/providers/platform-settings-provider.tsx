'use client';

/**
 * Platform display settings (reward unit, currency, points label) + the ONLY sanctioned way to
 * format amounts in the UI. Every amount must go through `useFormatAmount()` / `<Amount>` — never
 * `Number(x) / 100`, never `toFixed`, never a hard-coded currency symbol.
 *
 * Settings come from `GET /api/v1/settings/public` (public, cached for 5 minutes). The query runs
 * lazily in the components that format amounts, so pages without amounts never fetch it.
 * Historic rewards/ledger rows and program prices carry their own unit + currency: pass them as an
 * override so they render with what was stored, not with today's platform default.
 */
import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';
import { queryOptions, useQuery } from '@tanstack/react-query';
import {
  DEFAULT_LOCALE,
  SUPPORTED_CURRENCIES,
  formatAmount as sharedFormatAmount,
  formatCurrency as sharedFormatCurrency,
  unitSymbol as sharedUnitSymbol,
  type AmountFormat,
  type RewardUnit,
} from '@app/shared';

import { api } from '@/lib/api-client';
import { queryKeys } from '@/lib/query-keys';
import type { PublicSettings } from '@/lib/types';

/** Amount value as delivered by the API (bigint decimal string) or a bigint. */
export type MinorAmount = string | bigint;

/**
 * Per-value format override. Use it for anything that stores its own unit/currency (a program's
 * snapshot, a reward row, a ledger account).
 */
export interface AmountFormatOverride {
  unit?: RewardUnit;
  currencyCode?: string;
  /** Defaults to the ISO 4217 minor units of `currencyCode`. */
  minorUnits?: number;
  pointsLabel?: string;
}

export interface CurrencyFormatOverride {
  currencyCode?: string;
  minorUnits?: number;
}

interface PlatformSettingsContextValue {
  /** Fixed settings (tests, previews) — skips the network request. */
  settings?: PublicSettings;
  locale: string;
}

const PlatformSettingsContext = createContext<PlatformSettingsContextValue>({
  locale: DEFAULT_LOCALE,
});

export interface PlatformSettingsProviderProps {
  children: ReactNode;
  /** Inject settings instead of fetching them (Storybook/tests/server-provided data). */
  settings?: PublicSettings;
  /** Intl locale for number formatting. Defaults to `@app/shared` DEFAULT_LOCALE. */
  locale?: string;
}

/** Mounted once in the root providers. */
export function PlatformSettingsProvider({
  children,
  settings,
  locale = DEFAULT_LOCALE,
}: PlatformSettingsProviderProps) {
  const value = useMemo(() => ({ settings, locale }), [settings, locale]);
  return (
    <PlatformSettingsContext.Provider value={value}>{children}</PlatformSettingsContext.Provider>
  );
}

export function publicSettingsQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.settings.public(),
    queryFn: ({ signal }) => api.get<PublicSettings>('/settings/public', { signal }),
    staleTime: 5 * 60_000,
  });
}

export interface PlatformSettingsState {
  settings: PublicSettings | undefined;
  isReady: boolean;
  isLoading: boolean;
  error: unknown;
  locale: string;
}

/** Raw public settings (undefined until loaded). */
export function usePlatformSettings(): PlatformSettingsState {
  const ctx = useContext(PlatformSettingsContext);
  const query = useQuery({ ...publicSettingsQueryOptions(), enabled: !ctx.settings });
  const settings = ctx.settings ?? query.data;
  return {
    settings,
    isReady: settings !== undefined,
    isLoading: !settings && query.isPending,
    error: query.error,
    locale: ctx.locale,
  };
}

/** ISO 4217 minor units for a currency (falls back to Intl, then 2). */
export function minorUnitsForCurrency(currencyCode: string, settings?: PublicSettings): number {
  if (settings && settings.currencyCode === currencyCode) return settings.currencyMinorUnits;
  const known = SUPPORTED_CURRENCIES.find((c) => c.code === currencyCode);
  if (known) return known.minorUnits;
  try {
    return (
      new Intl.NumberFormat('en', { style: 'currency', currency: currencyCode }).resolvedOptions()
        .maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}

function resolveFormat(
  settings: PublicSettings | undefined,
  locale: string,
  override?: AmountFormatOverride,
): AmountFormat | null {
  const unit = override?.unit ?? settings?.rewardUnit;
  const currencyCode = override?.currencyCode ?? settings?.currencyCode;
  if (!unit || !currencyCode) return null;
  return {
    unit,
    currencyCode,
    minorUnits:
      unit === 'POINTS'
        ? 0
        : (override?.minorUnits ?? minorUnitsForCurrency(currencyCode, settings)),
    pointsLabel: override?.pointsLabel ?? settings?.pointsLabel ?? 'Points',
    locale,
  };
}

/**
 * The reward-amount format (platform defaults merged with `override`), or `null` while the
 * platform settings are still loading and the override is incomplete.
 */
export function useAmountFormat(override?: AmountFormatOverride): AmountFormat | null {
  const { settings, locale } = usePlatformSettings();
  return resolveFormat(settings, locale, override);
}

const PENDING = '…';

export interface AmountFormatter {
  /** False until platform settings are loaded (render a skeleton instead of a guess). */
  isReady: boolean;
  /** Platform reward-unit format (null until ready). */
  format: AmountFormat | null;
  /** Formats a reward amount in the platform reward unit (or the override's unit/currency). */
  formatAmount: (value: MinorAmount, override?: AmountFormatOverride) => string;
  /** Formats a currency amount (prices, sale values) regardless of the reward unit. */
  formatCurrency: (value: MinorAmount, override?: CurrencyFormatOverride) => string;
  /** Currency symbol ("₹") or the points label ("Points"). */
  unitSymbol: (override?: AmountFormatOverride) => string;
}

/**
 * Formatting functions bound to the platform settings. Values are bigint decimal strings from the
 * API ("150000"); conversion to major units happens inside `@app/shared` without floats.
 *
 * @example
 *   const { formatAmount, formatCurrency } = useFormatAmount();
 *   formatAmount(reward.amountMinor, { unit: reward.unit, currencyCode: reward.currencyCode });
 *   formatCurrency(option.priceMinor, { currencyCode: program.currencyCode });
 */
export function useFormatAmount(): AmountFormatter {
  const { settings, locale } = usePlatformSettings();
  const format = useMemo(() => resolveFormat(settings, locale), [settings, locale]);

  const formatAmount = useCallback(
    (value: MinorAmount, override?: AmountFormatOverride) => {
      const fmt = resolveFormat(settings, locale, override);
      if (!fmt) return PENDING;
      try {
        return sharedFormatAmount(value, fmt);
      } catch {
        return String(value);
      }
    },
    [settings, locale],
  );

  const formatCurrency = useCallback(
    (value: MinorAmount, override?: CurrencyFormatOverride) => {
      const currencyCode = override?.currencyCode ?? settings?.currencyCode;
      if (!currencyCode) return PENDING;
      const minorUnits = override?.minorUnits ?? minorUnitsForCurrency(currencyCode, settings);
      try {
        return sharedFormatCurrency(value, currencyCode, minorUnits, locale);
      } catch {
        return String(value);
      }
    },
    [settings, locale],
  );

  const unitSymbol = useCallback(
    (override?: AmountFormatOverride) => {
      const fmt = resolveFormat(settings, locale, override);
      return fmt ? sharedUnitSymbol(fmt) : '';
    },
    [settings, locale],
  );

  return { isReady: format !== null, format, formatAmount, formatCurrency, unitSymbol };
}
