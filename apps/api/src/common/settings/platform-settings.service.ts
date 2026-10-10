import { Injectable } from '@nestjs/common';
import type { AmountFormat, RewardUnit } from '@app/shared';
import type { PlatformSettings } from '../../generated/prisma/client';
import { staleVersion, validationFailed } from '../errors/app-error';
import { PrismaService, type Db } from '../prisma/prisma.service';

export const PLATFORM_SETTINGS_ID = 1;
const CACHE_TTL_MS = 30_000;

type SettingsFormatFields = Pick<PlatformSettings, 'rewardUnit' | 'currencyCode' | 'currencyMinorUnits' | 'pointsLabel'>;

/**
 * Platform-level display format from the settings row (POINTS → 0 minor units). Use it ONLY for things
 * that have no stored unit (empty states, form defaults). Records carry their own unit/currency: use
 * `toRecordAmountFormat`.
 */
export function toAmountFormat(settings: SettingsFormatFields): AmountFormat {
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
 * Format of an amount stored on a record (program, calculation, reward, ledger entry) from the
 * record's OWN snapshot — never the live settings. Pass `currencyMinorUnits` (programs/calculations)
 * or `minorUnits`; rewards/ledger rows only store unit + currency, so pass the program's minor units.
 * POINTS amounts always use 0 minor units. `pointsLabel` comes from the settings (display only).
 */
export function toRecordAmountFormat(
  record: { rewardUnit: RewardUnit; currencyCode: string; currencyMinorUnits?: number; minorUnits?: number },
  pointsLabel: string,
): AmountFormat {
  const minor = record.currencyMinorUnits ?? record.minorUnits;
  if (record.rewardUnit === 'MONEY' && minor === undefined) {
    throw new Error('toRecordAmountFormat: MONEY amounts need the record\'s currency minor units');
  }
  return {
    unit: record.rewardUnit,
    currencyCode: record.currencyCode,
    minorUnits: record.rewardUnit === 'POINTS' ? 0 : minor!,
    pointsLabel,
  };
}

/** Snapshot copied into a new program (business rules §1). */
export function programSnapshotFrom(settings: Pick<PlatformSettings, 'rewardUnit' | 'currencyCode' | 'currencyMinorUnits'>) {
  return { rewardUnit: settings.rewardUnit, currencyCode: settings.currencyCode, currencyMinorUnits: settings.currencyMinorUnits };
}

/** Defaults copied into a new policy draft (business rules §1, §7). */
export function policyDefaultsFrom(settings: Pick<PlatformSettings, 'defaultRewardBudgetBps' | 'pointsPerCurrencyUnit'>) {
  return { budgetBps: settings.defaultRewardBudgetBps, pointsPerCurrencyUnit: settings.pointsPerCurrencyUnit };
}

export interface PlatformSettingsPatch {
  rewardUnit?: RewardUnit;
  /** ISO 4217 code present in `currencies`; the minor units are taken from that table. */
  currencyCode?: string;
  pointsLabel?: string;
  pointsPerCurrencyUnit?: number;
  defaultRewardBudgetBps?: number;
}

/**
 * Singleton platform settings (row id = 1, created with schema defaults on first access).
 * - `get()` without a db uses a 30 s in-memory cache.
 * - `get(tx)` always reads through the given transaction (no cache) — use it when the value drives a
 *   write (e.g. snapshotting unit/currency into a new program).
 * - `update(tx, …)` performs the optimistic-concurrency update; the DB trigger bumps `version`.
 *   Call `invalidate()` after the transaction commits.
 */
@Injectable()
export class PlatformSettingsService {
  private cached: { value: PlatformSettings; at: number } | null = null;

  constructor(private readonly prisma: PrismaService) {}

  async get(db?: Db): Promise<PlatformSettings> {
    if (!db && this.cached && Date.now() - this.cached.at < CACHE_TTL_MS) return this.cached.value;
    const client = db ?? this.prisma;
    let value = await client.platformSettings.findUnique({ where: { id: PLATFORM_SETTINGS_ID } });
    if (!value) {
      // INSERT … ON CONFLICT DO NOTHING (never an UPDATE, which would bump the version).
      await client.platformSettings.createMany({ data: [{ id: PLATFORM_SETTINGS_ID }], skipDuplicates: true });
      value = await client.platformSettings.findUniqueOrThrow({ where: { id: PLATFORM_SETTINGS_ID } });
    }
    if (!db) this.cached = { value, at: Date.now() };
    return value;
  }

  async getAmountFormat(db?: Db): Promise<AmountFormat> {
    return toAmountFormat(await this.get(db));
  }

  /**
   * Updates the singleton if its version is still `expectedVersion` (else 409 STALE_VERSION). Never
   * writes `version` itself — the `trg_platform_settings_guard` trigger increments it (and blocks a
   * currency change while live programs use another currency → 409 INVARIANT_VIOLATION). Returns the
   * row before and after. Audit it in the same transaction (with the reason) and `invalidate()` after
   * commit.
   */
  async update(
    db: Db,
    input: { expectedVersion: number; patch: PlatformSettingsPatch; actorUserId: string | null },
  ): Promise<{ before: PlatformSettings; after: PlatformSettings }> {
    const before = await this.get(db);
    const { currencyCode, ...rest } = input.patch;
    let currency: { currencyCode: string; currencyMinorUnits: number } | undefined;
    if (currencyCode !== undefined && currencyCode !== before.currencyCode) {
      const row = await db.currency.findUnique({ where: { code: currencyCode }, select: { code: true, minorUnits: true } });
      if (!row) throw validationFailed('Unsupported currency', { issues: [{ path: 'currencyCode', message: 'Unknown currency', code: 'custom' }] });
      currency = { currencyCode: row.code, currencyMinorUnits: row.minorUnits };
    }
    const res = await db.platformSettings.updateMany({
      where: { id: PLATFORM_SETTINGS_ID, version: input.expectedVersion },
      data: { ...rest, ...(currency ?? {}), updatedById: input.actorUserId },
    });
    if (res.count !== 1) throw staleVersion();
    const after = await db.platformSettings.findUniqueOrThrow({ where: { id: PLATFORM_SETTINGS_ID } });
    this.invalidate();
    return { before, after };
  }

  invalidate(): void {
    this.cached = null;
  }
}
