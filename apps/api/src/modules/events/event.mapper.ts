import type {
  CalcTraceStepDto,
  IntegrationSaleResultDto,
  SaleComplianceDto,
  SaleCalculationAncestorDto,
  SaleEventCalculationDto,
  SaleEventDetailDto,
  SaleEventDto,
  SaleEventRevisionDto,
  SaleEventRewardDto,
} from '@app/shared';
import type { Prisma } from '../../generated/prisma/client';
import { deriveOutcome } from './domain/intake';

export const saleEventInclude = {
  program: {
    select: { id: true, code: true, name: true, rewardUnit: true, currencyCode: true, currencyMinorUnits: true, timezone: true },
  },
  subject: { select: { id: true, fullName: true } },
  recordedBy: { select: { id: true, fullName: true } },
  apiClient: { select: { id: true, name: true, keyPrefix: true } },
  policyVersion: { select: { version: true } },
  supersededBy: { select: { id: true } },
  calculation: { select: { outcome: true } },
} satisfies Prisma.QualifyingEventInclude;

export type SaleEventRow = Prisma.QualifyingEventGetPayload<{ include: typeof saleEventInclude }>;

export const saleEventDetailInclude = {
  ...saleEventInclude,
  calculation: true,
  rewards: { orderBy: { level: 'asc' }, include: { recipient: { select: { id: true, fullName: true } } } },
} satisfies Prisma.QualifyingEventInclude;

export type SaleEventDetailRow = Prisma.QualifyingEventGetPayload<{ include: typeof saleEventDetailInclude }>;

export interface RewardStats {
  count: number;
  totalMinor: bigint;
}

const iso = (d: Date | null | undefined) => d?.toISOString() ?? null;

export function toSaleEventDto(row: SaleEventRow | SaleEventDetailRow, stats: RewardStats): SaleEventDto {
  return {
    id: row.id,
    programId: row.programId,
    program: { ...row.program },
    offeringId: row.offeringId,
    type: row.type,
    source: row.source,
    externalId: row.externalId,
    revision: row.revision,
    supersedesEventId: row.supersedesEventId,
    supersededByEventId: row.supersededBy?.id ?? null,
    customerReference: row.customerReference,
    subject: { id: row.subject.id, fullName: row.subject.fullName },
    amountMinor: row.amountMinor.toString(),
    currencyCode: row.currencyCode,
    occurredAt: row.occurredAt.toISOString(),
    status: row.status,
    outcome: deriveOutcome(row.status, row.calculation?.outcome ?? null),
    rejectionReason: row.rejectionReason,
    processedAt: iso(row.processedAt),
    reversedAt: iso(row.reversedAt),
    reversalReason: row.reversalReason,
    description: row.description,
    policyVersionId: row.policyVersionId,
    policyVersion: row.policyVersion?.version ?? null,
    recordedBy: row.recordedBy ? { id: row.recordedBy.id, fullName: row.recordedBy.fullName } : null,
    apiClient: row.apiClient ? { id: row.apiClient.id, name: row.apiClient.name, keyPrefix: row.apiClient.keyPrefix } : null,
    rewardCount: stats.count,
    rewardTotalMinor: stats.totalMinor.toString(),
    createdAt: row.createdAt.toISOString(),
  };
}

function toRewardDto(r: SaleEventDetailRow['rewards'][number]): SaleEventRewardDto {
  return {
    id: r.id,
    level: r.level,
    recipient: { id: r.recipient.id, fullName: r.recipient.fullName },
    amountMinor: r.amountMinor.toString(),
    rewardUnit: r.rewardUnit,
    currencyCode: r.currencyCode,
    status: r.status,
    createdAt: r.createdAt.toISOString(),
    approvedAt: iso(r.approvedAt),
    rejectedAt: iso(r.rejectedAt),
    postedAt: iso(r.postedAt),
    reversedAt: iso(r.reversedAt),
    rejectionReason: r.rejectionReason,
    reversalReason: r.reversalReason,
  };
}

interface ParsedTrace {
  steps: CalcTraceStepDto[];
  warnings: string[];
  ancestors: Array<{ userId: string; depth: number; eligible: boolean; reason: string | null }>;
}

/** Defensive read of the stored trace JSON (written by the engine's `serializeTrace`). */
export function parseTrace(trace: unknown): ParsedTrace {
  const t = (trace !== null && typeof trace === 'object' ? trace : {}) as Record<string, unknown>;
  const steps = Array.isArray(t.steps) ? (t.steps as CalcTraceStepDto[]) : [];
  const warnings = Array.isArray(t.warnings) ? t.warnings.filter((w): w is string => typeof w === 'string') : [];
  const ancestors = Array.isArray(t.ancestorsConsidered)
    ? (t.ancestorsConsidered as unknown[]).flatMap((a) => {
        const o = (a ?? {}) as Record<string, unknown>;
        if (typeof o.userId !== 'string' || typeof o.depth !== 'number') return [];
        return [{ userId: o.userId, depth: o.depth, eligible: o.eligible === true, reason: typeof o.reason === 'string' ? o.reason : null }];
      })
    : [];
  return { steps, warnings, ancestors };
}

export function toSaleEventDetailDto(
  row: SaleEventDetailRow,
  extras: { names: ReadonlyMap<string, string>; revisions: SaleEventRevisionDto[]; compliance: SaleComplianceDto },
): SaleEventDetailDto {
  const totalMinor = row.rewards.reduce((sum, r) => sum + r.amountMinor, 0n);
  let calculation: SaleEventCalculationDto | null = null;
  if (row.calculation) {
    const c = row.calculation;
    const trace = parseTrace(c.trace);
    calculation = {
      id: c.id,
      outcome: c.outcome,
      rewardUnit: c.rewardUnit,
      currencyCode: c.currencyCode,
      currencyMinorUnits: c.currencyMinorUnits,
      pointsPerCurrencyUnit: c.pointsPerCurrencyUnit,
      baseMinor: c.baseMinor.toString(),
      budgetBps: c.budgetBps,
      budgetMinor: c.budgetMinor.toString(),
      totalAllocatedMinor: c.totalAllocatedMinor.toString(),
      engineVersion: c.engineVersion,
      createdAt: c.createdAt.toISOString(),
      ancestors: trace.ancestors.map(
        (a): SaleCalculationAncestorDto => ({ ...a, fullName: extras.names.get(a.userId) ?? null }),
      ),
      steps: trace.steps,
      warnings: trace.warnings,
    };
  }
  return {
    ...toSaleEventDto(row, { count: row.rewards.length, totalMinor }),
    calculation,
    rewards: row.rewards.map(toRewardDto),
    revisions: extras.revisions,
    compliance: extras.compliance,
  };
}

export function toIntegrationResultDto(row: SaleEventRow, replayed: boolean): IntegrationSaleResultDto {
  return {
    id: row.id,
    programId: row.programId,
    externalId: row.externalId,
    revision: row.revision,
    type: row.type,
    amountMinor: row.amountMinor.toString(),
    currencyCode: row.currencyCode,
    occurredAt: row.occurredAt.toISOString(),
    status: row.status,
    outcome: deriveOutcome(row.status, row.calculation?.outcome ?? null),
    rejectionReason: row.rejectionReason,
    createdAt: row.createdAt.toISOString(),
    replayed,
  };
}
