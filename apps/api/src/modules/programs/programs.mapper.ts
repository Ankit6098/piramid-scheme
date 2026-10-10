import {
  EnrollmentStatus,
  programEditableFields,
  programLifecycleActions,
  type AdminProgramDetailDto,
  type AdminProgramSummaryDto,
  type CatalogUserRef,
  type ProgramOptionDto,
  type ProgramPolicySummary,
  type ProgramPublishCheck,
  type ProgramStatusChangeDto,
} from '@app/shared';
import type { Prisma } from '../../generated/prisma/client';
import { parseEligibility } from '../enrollments/domain/enrollment-rules';

const userRef = { select: { id: true, fullName: true } } as const;

export const programSummaryInclude = {
  offering: { select: { id: true, name: true, kind: true, status: true } },
  _count: { select: { options: { where: { isActive: true } } } },
} satisfies Prisma.ProgramInclude;

export type ProgramSummaryRow = Prisma.ProgramGetPayload<{ include: typeof programSummaryInclude }>;

export const programDetailInclude = {
  offering: { select: { id: true, name: true, kind: true, status: true } },
  createdBy: userRef,
  updatedBy: userRef,
  options: {
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    include: { _count: { select: { enrollments: true } } },
  },
  statusChanges: { orderBy: [{ changedAt: 'desc' }], take: 100, include: { changedBy: userRef } },
  _count: { select: { options: { where: { isActive: true } }, adminAssignments: true } },
} satisfies Prisma.ProgramInclude;

export type ProgramDetailRow = Prisma.ProgramGetPayload<{ include: typeof programDetailInclude }>;

type OptionRow = Prisma.ProgramOptionGetPayload<{ include: { _count: { select: { enrollments: true } } } }>;

export function toUserRef(u: { id: string; fullName: string } | null | undefined): CatalogUserRef | null {
  return u ? { id: u.id, fullName: u.fullName } : null;
}

export interface EnrollmentHeadcount {
  active: number;
  pending: number;
}

type SummarySource = Omit<ProgramSummaryRow, '_count'> & { _count: { options: number } };

export function toProgramSummary(row: SummarySource, counts: EnrollmentHeadcount): AdminProgramSummaryDto {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    status: row.status,
    offering: { id: row.offering.id, name: row.offering.name, kind: row.offering.kind, status: row.offering.status },
    rewardUnit: row.rewardUnit,
    currencyCode: row.currencyCode,
    currencyMinorUnits: row.currencyMinorUnits,
    timezone: row.timezone,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt?.toISOString() ?? null,
    enrollmentOpensAt: row.enrollmentOpensAt.toISOString(),
    enrollmentClosesAt: row.enrollmentClosesAt?.toISOString() ?? null,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    version: row.version,
    activeOptionCount: row._count.options,
    activeEnrollmentCount: counts.active,
    pendingEnrollmentCount: counts.pending,
  };
}

export function toOptionDto(o: OptionRow): ProgramOptionDto {
  return {
    id: o.id,
    programId: o.programId,
    name: o.name,
    description: o.description,
    priceMinor: o.priceMinor.toString(),
    currencyCode: o.currencyCode,
    billingFrequency: o.billingFrequency,
    durationDays: o.durationDays,
    renewalPolicy: o.renewalPolicy,
    isActive: o.isActive,
    sortOrder: o.sortOrder,
    enrollmentCount: o._count.enrollments,
    termsLocked: o._count.enrollments > 0,
    createdAt: o.createdAt.toISOString(),
    updatedAt: o.updatedAt.toISOString(),
  };
}

export function toStatusChangeDto(c: ProgramDetailRow['statusChanges'][number]): ProgramStatusChangeDto {
  return {
    id: c.id,
    fromStatus: c.fromStatus,
    toStatus: c.toStatus,
    changedAt: c.changedAt.toISOString(),
    changedBy: toUserRef(c.changedBy),
    reason: c.reason,
  };
}

export interface ProgramDetailExtras {
  enrollmentCounts: Partial<Record<EnrollmentStatus, number>>;
  policySummary: ProgramPolicySummary;
  publishChecks: ProgramPublishCheck[];
  canDelete: boolean;
}

export function toProgramDetail(row: ProgramDetailRow, extras: ProgramDetailExtras): AdminProgramDetailDto {
  const counts = Object.fromEntries(EnrollmentStatus.map((s) => [s, extras.enrollmentCounts[s] ?? 0])) as Record<
    EnrollmentStatus,
    number
  >;
  return {
    ...toProgramSummary(row, { active: counts.ACTIVE, pending: counts.PENDING }),
    description: row.description,
    maxRewardDepth: row.maxRewardDepth,
    lateEventGraceDays: row.lateEventGraceDays,
    eligibility: parseEligibility(row.eligibility),
    termsVersion: row.termsVersion,
    termsText: row.termsText,
    createdBy: toUserRef(row.createdBy),
    updatedBy: toUserRef(row.updatedBy),
    options: row.options.map(toOptionDto),
    policySummary: extras.policySummary,
    enrollmentCounts: counts,
    statusHistory: row.statusChanges.map(toStatusChangeDto),
    adminCount: row._count.adminAssignments,
    publishChecks: extras.publishChecks,
    editableFields: [...programEditableFields(row.status)],
    allowedActions: programLifecycleActions(row.status),
    canDelete: extras.canDelete,
  };
}
