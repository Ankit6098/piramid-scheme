import { Injectable } from '@nestjs/common';
import {
  ErrorCode,
  LIVE_PROGRAM_STATUSES,
  type CurrencyDto,
  type PlatformSettingsDto,
  type PublicSettingsDto,
  type UpdatePlatformSettingsInput,
} from '@app/shared';
import {
  AppError,
  AuditService,
  PlatformSettingsService,
  PrismaService,
  staleVersion,
  validationFailed,
  type AuthContext,
  type Db,
  type PlatformSettingsPatch,
} from '../../common';
import type { PlatformSettings } from '../../generated/prisma/client';

/** Audited setting fields (allow-list for audit before/after). */
const AUDITED_FIELDS = [
  'rewardUnit',
  'currencyCode',
  'currencyMinorUnits',
  'pointsLabel',
  'pointsPerCurrencyUnit',
  'defaultRewardBudgetBps',
] as const;
type AuditedField = (typeof AUDITED_FIELDS)[number];

function pick(s: PlatformSettings, fields: readonly AuditedField[]): Partial<Record<AuditedField, unknown>> {
  return Object.fromEntries(fields.map((f) => [f, s[f]]));
}

export function toPublicSettingsDto(s: Pick<PlatformSettings, 'rewardUnit' | 'currencyCode' | 'currencyMinorUnits' | 'pointsLabel'>): PublicSettingsDto {
  return {
    rewardUnit: s.rewardUnit,
    currencyCode: s.currencyCode,
    currencyMinorUnits: s.currencyMinorUnits,
    pointsLabel: s.pointsLabel,
  };
}

/**
 * Platform settings use cases (business rules §1): public display format, SUPER_ADMIN view and
 * audited, optimistic updates. The platform currency cannot change while live programs use another
 * currency (pre-checked here for a friendly error; enforced by `trg_platform_settings_guard`).
 */
@Injectable()
export class SettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: PlatformSettingsService,
    private readonly audit: AuditService,
  ) {}

  async getPublic(): Promise<PublicSettingsDto> {
    return toPublicSettingsDto(await this.settings.get());
  }

  async getAdmin(db: Db = this.prisma): Promise<PlatformSettingsDto> {
    const s = await this.settings.get(db);
    const updatedBy = s.updatedById
      ? await db.user.findUnique({ where: { id: s.updatedById }, select: { id: true, fullName: true } })
      : null;
    const live = await db.program.groupBy({
      by: ['currencyCode'],
      where: { status: { in: [...LIVE_PROGRAM_STATUSES] } },
      _count: { _all: true },
      orderBy: { currencyCode: 'asc' },
    });
    return {
      ...toPublicSettingsDto(s),
      pointsPerCurrencyUnit: s.pointsPerCurrencyUnit,
      defaultRewardBudgetBps: s.defaultRewardBudgetBps,
      payoutsEnabled: s.payoutsEnabled,
      version: s.version,
      updatedAt: s.updatedAt.toISOString(),
      updatedBy: updatedBy ? { id: updatedBy.id, fullName: updatedBy.fullName } : null,
      liveProgramCount: live.reduce((n, g) => n + g._count._all, 0),
      liveProgramCurrencyCodes: live.map((g) => g.currencyCode),
    };
  }

  async listCurrencies(): Promise<CurrencyDto[]> {
    const rows = await this.prisma.currency.findMany({ orderBy: { code: 'asc' } });
    return rows.map((c) => ({ code: c.code, name: c.name, minorUnits: c.minorUnits }));
  }

  /**
   * Applies the changed fields only (a request that changes nothing is a no-op and keeps the
   * version). Audited with the reason in the same transaction; the cache is invalidated after commit.
   */
  async update(auth: AuthContext, input: UpdatePlatformSettingsInput): Promise<PlatformSettingsDto> {
    await this.prisma.runInTransaction(async (tx) => {
      const current = await this.settings.get(tx);
      if (current.version !== input.expectedVersion) throw staleVersion();

      const patch: PlatformSettingsPatch = {};
      if (input.rewardUnit !== undefined && input.rewardUnit !== current.rewardUnit) patch.rewardUnit = input.rewardUnit;
      if (input.currencyCode !== undefined && input.currencyCode !== current.currencyCode) patch.currencyCode = input.currencyCode;
      if (input.pointsLabel !== undefined && input.pointsLabel !== current.pointsLabel) patch.pointsLabel = input.pointsLabel;
      if (input.pointsPerCurrencyUnit !== undefined && input.pointsPerCurrencyUnit !== current.pointsPerCurrencyUnit) {
        patch.pointsPerCurrencyUnit = input.pointsPerCurrencyUnit;
      }
      if (input.defaultRewardBudgetBps !== undefined && input.defaultRewardBudgetBps !== current.defaultRewardBudgetBps) {
        patch.defaultRewardBudgetBps = input.defaultRewardBudgetBps;
      }
      if (Object.keys(patch).length === 0) return;

      if (patch.currencyCode !== undefined) {
        const currency = await tx.currency.findUnique({ where: { code: patch.currencyCode }, select: { code: true } });
        if (!currency) {
          throw validationFailed('Unsupported currency', {
            issues: [{ path: 'currencyCode', message: 'This currency is not supported', code: 'custom' }],
          });
        }
        const blocking = await tx.program.findMany({
          where: { status: { in: [...LIVE_PROGRAM_STATUSES] }, currencyCode: { not: patch.currencyCode } },
          select: { id: true, code: true, name: true, status: true, currencyCode: true },
          orderBy: { createdAt: 'asc' },
          take: 20,
        });
        if (blocking.length > 0) {
          const codes = [...new Set(blocking.map((p) => p.currencyCode))].join(', ');
          throw new AppError(
            ErrorCode.InvariantViolation,
            `The platform currency can't change while live programs use ${codes}. Complete or archive them first.`,
            409,
            { programs: blocking.map((p) => ({ id: p.id, code: p.code, name: p.name, status: p.status, currencyCode: p.currencyCode })) },
          );
        }
      }

      const { before, after } = await this.settings.update(tx, {
        expectedVersion: input.expectedVersion,
        patch,
        actorUserId: auth.userId,
      });
      const fields = AUDITED_FIELDS.filter((f) => before[f] !== after[f]);
      await this.audit.record(tx, {
        action: 'settings.update',
        resourceType: 'platform_settings',
        resourceId: String(after.id),
        before: pick(before, fields),
        after: { ...pick(after, fields), version: after.version },
        reason: input.reason,
      });
    });
    this.settings.invalidate();
    return this.getAdmin();
  }
}
