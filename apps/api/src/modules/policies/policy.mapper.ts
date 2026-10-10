import type {
  MemberProgramPolicyDto,
  PolicyProgramContextDto,
  PolicyRuleDto,
  PolicyVersionDto,
  PolicyVersionSummaryDto,
} from '@app/shared';
import { POLICY_HARD_CAP_BPS } from '@app/shared';
import type { Prisma } from '../../generated/prisma/client';
import { policyPhase } from './domain/policy-timeline';

/** Relations loaded with every version row. */
export const policyVersionInclude = {
  rules: { orderBy: { level: 'asc' } },
  createdBy: { select: { id: true, fullName: true } },
  publishedBy: { select: { id: true, fullName: true } },
} satisfies Prisma.RewardPolicyVersionInclude;

export type PolicyVersionRow = Prisma.RewardPolicyVersionGetPayload<{ include: typeof policyVersionInclude }>;

export const programContextSelect = {
  id: true,
  code: true,
  name: true,
  status: true,
  rewardUnit: true,
  currencyCode: true,
  currencyMinorUnits: true,
  maxRewardDepth: true,
  timezone: true,
} satisfies Prisma.ProgramSelect;

export type ProgramContextRow = Prisma.ProgramGetPayload<{ select: typeof programContextSelect }>;

export function toProgramContextDto(p: ProgramContextRow): PolicyProgramContextDto {
  return {
    id: p.id,
    code: p.code,
    name: p.name,
    status: p.status,
    rewardUnit: p.rewardUnit,
    currencyCode: p.currencyCode,
    currencyMinorUnits: p.currencyMinorUnits,
    maxRewardDepth: p.maxRewardDepth,
    timezone: p.timezone,
  };
}

export function toRuleDto(r: PolicyVersionRow['rules'][number]): PolicyRuleDto {
  return {
    id: r.id,
    level: r.level,
    calcType: r.calcType,
    fixedAmountMinor: r.fixedAmountMinor?.toString() ?? null,
    percentageBps: r.percentageBps,
    capMinor: r.capMinor?.toString() ?? null,
  };
}

export function toPolicySummaryDto(row: PolicyVersionRow, now: Date): PolicyVersionSummaryDto {
  const isDraft = row.status === 'DRAFT';
  return {
    id: row.id,
    programId: row.programId,
    version: row.version,
    status: row.status,
    phase: policyPhase(row, now),
    name: row.name,
    notes: row.notes,
    triggerEventTypes: [...row.triggerEventTypes],
    maxDepth: row.maxDepth,
    budgetBps: row.budgetBps,
    maxTotalPerEventMinor: row.maxTotalPerEventMinor?.toString() ?? null,
    minEventAmountMinor: row.minEventAmountMinor.toString(),
    pointsPerCurrencyUnit: row.pointsPerCurrencyUnit,
    ineligibleAncestorBehavior: row.ineligibleAncestorBehavior,
    roundingMode: row.roundingMode,
    requiresApproval: row.requiresApproval,
    requireActiveEnrollment: row.requireActiveEnrollment,
    // A draft's stored start is a placeholder until it is published.
    effectiveFrom: isDraft ? null : row.effectiveFrom.toISOString(),
    effectiveTo: isDraft ? null : (row.effectiveTo?.toISOString() ?? null),
    publishedAt: row.publishedAt?.toISOString() ?? null,
    retiredAt: row.retiredAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    createdBy: row.createdBy ? { id: row.createdBy.id, fullName: row.createdBy.fullName } : null,
    publishedBy: row.publishedBy ? { id: row.publishedBy.id, fullName: row.publishedBy.fullName } : null,
    ruleCount: row.rules.length,
    percentageTotalBps: row.rules.reduce((sum, r) => sum + (r.calcType === 'PERCENTAGE' ? (r.percentageBps ?? 0) : 0), 0),
  };
}

export function toPolicyDto(row: PolicyVersionRow, program: ProgramContextRow, boundEventCount: number, now: Date): PolicyVersionDto {
  return {
    ...toPolicySummaryDto(row, now),
    rules: row.rules.map(toRuleDto),
    program: toProgramContextDto(program),
    boundEventCount,
  };
}

export function toMemberPolicyDto(
  row: PolicyVersionRow,
  program: Pick<ProgramContextRow, 'id' | 'rewardUnit' | 'currencyCode' | 'currencyMinorUnits'>,
  inEffect: boolean,
): MemberProgramPolicyDto {
  return {
    programId: program.id,
    version: row.version,
    rewardUnit: program.rewardUnit,
    currencyCode: program.currencyCode,
    currencyMinorUnits: program.currencyMinorUnits,
    triggerEventTypes: [...row.triggerEventTypes],
    budgetBps: row.budgetBps,
    hardCapBps: POLICY_HARD_CAP_BPS,
    maxDepth: row.maxDepth,
    maxTotalPerEventMinor: row.maxTotalPerEventMinor?.toString() ?? null,
    minEventAmountMinor: row.minEventAmountMinor.toString(),
    effectiveFrom: row.effectiveFrom.toISOString(),
    effectiveTo: row.effectiveTo?.toISOString() ?? null,
    inEffect,
    levels: row.rules.map((r) => ({
      level: r.level,
      calcType: r.calcType,
      percentageBps: r.percentageBps,
      fixedAmountMinor: r.fixedAmountMinor?.toString() ?? null,
      capMinor: r.capMinor?.toString() ?? null,
    })),
  };
}
