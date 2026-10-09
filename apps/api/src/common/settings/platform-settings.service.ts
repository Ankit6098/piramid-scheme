import { Injectable } from '@nestjs/common';
import type { AmountFormat } from '@app/shared';
import type { PlatformSettings } from '../../generated/prisma/client';
import { PrismaService, type Db } from '../prisma/prisma.service';

export const PLATFORM_SETTINGS_ID = 1;
const CACHE_TTL_MS = 30_000;

/** Amount format for platform-level display (programs/rewards carry their own unit + currency). */
export function toAmountFormat(settings: Pick<PlatformSettings, 'rewardUnit' | 'currencyCode' | 'currencyMinorUnits' | 'pointsLabel'>): AmountFormat {
  return {
    unit: settings.rewardUnit,
    currencyCode: settings.currencyCode,
    minorUnits: settings.rewardUnit === 'POINTS' ? 0 : settings.currencyMinorUnits,
    pointsLabel: settings.pointsLabel,
  };
}

/** Currency format (prices, sale amounts) regardless of the reward unit. */
export function toCurrencyFormat(settings: Pick<PlatformSettings, 'currencyCode' | 'currencyMinorUnits' | 'pointsLabel'>): AmountFormat {
  return { unit: 'MONEY', currencyCode: settings.currencyCode, minorUnits: settings.currencyMinorUnits, pointsLabel: settings.pointsLabel };
}

/**
 * Singleton platform settings (row id = 1, created with schema defaults on first access).
 * - `get()` without a db uses a 30 s in-memory cache.
 * - `get(tx)` always reads through the given transaction (no cache) — use it when the value drives a
 *   write (e.g. snapshotting unit/currency into a new program).
 * The settings slice must call `invalidate()` after updating the row.
 */
@Injectable()
export class PlatformSettingsService {
  private cached: { value: PlatformSettings; at: number } | null = null;

  constructor(private readonly prisma: PrismaService) {}

  async get(db?: Db): Promise<PlatformSettings> {
    if (!db && this.cached && Date.now() - this.cached.at < CACHE_TTL_MS) return this.cached.value;
    const client = db ?? this.prisma;
    const existing = await client.platformSettings.findUnique({ where: { id: PLATFORM_SETTINGS_ID } });
    const value =
      existing ??
      (await client.platformSettings.upsert({
        where: { id: PLATFORM_SETTINGS_ID },
        create: { id: PLATFORM_SETTINGS_ID },
        update: {},
      }));
    if (!db) this.cached = { value, at: Date.now() };
    return value;
  }

  async getAmountFormat(db?: Db): Promise<AmountFormat> {
    return toAmountFormat(await this.get(db));
  }

  invalidate(): void {
    this.cached = null;
  }
}
