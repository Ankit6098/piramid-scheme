import type { RewardUnit } from './enums';

/** Everything needed to render an amount consistently anywhere in the product. */
export interface AmountFormat {
  unit: RewardUnit;
  currencyCode: string;
  /** Minor units of the currency (e.g. 2 for INR/USD). Points always use 0. */
  minorUnits: number;
  pointsLabel: string;
  locale?: string;
}

export const DEFAULT_LOCALE = 'en-IN';

type MinorInput = bigint | string | number;

function toBigInt(value: MinorInput): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) throw new Error('Minor amounts must be integers');
    return BigInt(value);
  }
  if (!/^-?\d+$/.test(value)) throw new Error(`Invalid minor amount: ${value}`);
  return BigInt(value);
}

/** Converts integer minor units to an exact decimal string (150000, 2 → "1500.00"). */
export function minorToDecimalString(value: MinorInput, minorUnits: number): string {
  const v = toBigInt(value);
  const negative = v < 0n;
  const abs = negative ? -v : v;
  if (minorUnits === 0) return `${negative ? '-' : ''}${abs.toString()}`;
  const s = abs.toString().padStart(minorUnits + 1, '0');
  const whole = s.slice(0, s.length - minorUnits);
  const frac = s.slice(s.length - minorUnits);
  return `${negative ? '-' : ''}${whole}.${frac}`;
}

/**
 * Parses a user-entered decimal ("1,500.5") into integer minor units. Returns null when invalid or
 * when it has more fraction digits than the currency allows. Never uses floating point.
 */
export function decimalToMinor(input: string, minorUnits: number): bigint | null {
  const cleaned = input.replace(/[\s,_]/g, '');
  const match = /^(\d+)(?:\.(\d*))?$/.exec(cleaned);
  if (!match) return null;
  const whole = match[1] ?? '0';
  const frac = match[2] ?? '';
  if (frac.length > minorUnits) return null;
  return BigInt(whole + frac.padEnd(minorUnits, '0'));
}

/**
 * Formats an amount for display. MONEY → localized currency ("₹1,500.00");
 * POINTS → grouped integer + label ("1,500 Points").
 */
export function formatAmount(value: MinorInput, fmt: AmountFormat): string {
  const locale = fmt.locale ?? DEFAULT_LOCALE;
  if (fmt.unit === 'POINTS') {
    const n = toBigInt(value);
    return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(n)} ${fmt.pointsLabel}`;
  }
  const decimal = minorToDecimalString(value, fmt.minorUnits);
  // Intl.NumberFormat accepts exact decimal strings, so no float rounding happens here.
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: fmt.currencyCode,
    minimumFractionDigits: fmt.minorUnits,
    maximumFractionDigits: fmt.minorUnits,
  }).format(decimal as unknown as number);
}

/** Formats a currency amount (prices, sale values) regardless of the reward unit. */
export function formatCurrency(
  value: MinorInput,
  currencyCode: string,
  minorUnits: number,
  locale = DEFAULT_LOCALE,
): string {
  return formatAmount(value, { unit: 'MONEY', currencyCode, minorUnits, pointsLabel: '', locale });
}

/** Short symbol for compact UI (e.g. "₹", "$", or the points label). */
export function unitSymbol(
  fmt: Pick<AmountFormat, 'unit' | 'currencyCode' | 'pointsLabel' | 'locale'>,
): string {
  if (fmt.unit === 'POINTS') return fmt.pointsLabel;
  const parts = new Intl.NumberFormat(fmt.locale ?? DEFAULT_LOCALE, {
    style: 'currency',
    currency: fmt.currencyCode,
  }).formatToParts(0);
  return parts.find((p) => p.type === 'currency')?.value ?? fmt.currencyCode;
}

/** Formats basis points as a percentage string (250 → "2.5%", 1000 → "10%"). */
export function formatBps(bps: number): string {
  const whole = Math.trunc(bps / 100);
  const frac = Math.abs(bps % 100);
  if (frac === 0) return `${whole}%`;
  return `${whole}.${frac.toString().padStart(2, '0').replace(/0$/, '')}%`;
}

/** Currencies offered in the settings UI with their ISO 4217 minor units. */
export const SUPPORTED_CURRENCIES: ReadonlyArray<{ code: string; name: string; minorUnits: number }> = [
  { code: 'INR', name: 'Indian Rupee', minorUnits: 2 },
  { code: 'USD', name: 'US Dollar', minorUnits: 2 },
  { code: 'EUR', name: 'Euro', minorUnits: 2 },
  { code: 'GBP', name: 'British Pound', minorUnits: 2 },
  { code: 'AED', name: 'UAE Dirham', minorUnits: 2 },
  { code: 'SGD', name: 'Singapore Dollar', minorUnits: 2 },
  { code: 'AUD', name: 'Australian Dollar', minorUnits: 2 },
  { code: 'CAD', name: 'Canadian Dollar', minorUnits: 2 },
  { code: 'JPY', name: 'Japanese Yen', minorUnits: 0 },
  { code: 'NPR', name: 'Nepalese Rupee', minorUnits: 2 },
  { code: 'LKR', name: 'Sri Lankan Rupee', minorUnits: 2 },
  { code: 'BDT', name: 'Bangladeshi Taka', minorUnits: 2 },
];
