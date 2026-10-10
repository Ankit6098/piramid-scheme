import {
  BillingFrequency,
  RenewalPolicy,
  type AdminEnrollmentDto,
  type EnrollmentOptionSnapshotDto,
  type MyEnrollmentDto,
} from '@app/shared';
import type { Prisma } from '../../generated/prisma/client';
import { adminEnrollmentActions, canCancel } from './domain/enrollment-rules';

const userRef = { select: { id: true, fullName: true } } as const;

export const enrollmentInclude = {
  program: {
    select: { id: true, code: true, name: true, status: true, timezone: true, currencyCode: true, currencyMinorUnits: true },
  },
} satisfies Prisma.ProgramEnrollmentInclude;

export const adminEnrollmentInclude = {
  ...enrollmentInclude,
  user: { select: { id: true, fullName: true, email: true } },
  sponsor: userRef,
  paymentRecordedBy: userRef,
} satisfies Prisma.ProgramEnrollmentInclude;

export type EnrollmentRow = Prisma.ProgramEnrollmentGetPayload<{ include: typeof enrollmentInclude }>;
export type AdminEnrollmentRow = Prisma.ProgramEnrollmentGetPayload<{ include: typeof adminEnrollmentInclude }>;

/** Reads the immutable option snapshot (JSON) defensively. */
export function parseSnapshot(value: unknown, fallback: { optionId: string; currencyCode: string }): EnrollmentOptionSnapshotDto {
  const s = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const str = (v: unknown, d: string) => (typeof v === 'string' ? v : d);
  const frequency = str(s.billingFrequency, 'ONE_TIME');
  const renewal = str(s.renewalPolicy, 'MANUAL');
  const price = s.priceMinor;
  return {
    optionId: str(s.optionId, fallback.optionId),
    name: str(s.name, 'Plan'),
    priceMinor: typeof price === 'string' && /^\d+$/.test(price) ? price : typeof price === 'number' ? String(price) : '0',
    currencyCode: str(s.currencyCode, fallback.currencyCode),
    billingFrequency: ((BillingFrequency as readonly string[]).includes(frequency) ? frequency : 'ONE_TIME') as EnrollmentOptionSnapshotDto['billingFrequency'],
    durationDays: typeof s.durationDays === 'number' ? s.durationDays : 0,
    renewalPolicy: ((RenewalPolicy as readonly string[]).includes(renewal) ? renewal : 'MANUAL') as EnrollmentOptionSnapshotDto['renewalPolicy'],
  };
}

function base(row: EnrollmentRow, now: Date): Omit<MyEnrollmentDto, 'canCancel'> {
  return {
    id: row.id,
    status: row.status,
    eligibilityStatus: row.eligibilityStatus,
    program: {
      id: row.program.id,
      code: row.program.code,
      name: row.program.name,
      status: row.program.status,
      timezone: row.program.timezone,
      currencyCode: row.program.currencyCode,
      currencyMinorUnits: row.program.currencyMinorUnits,
    },
    option: parseSnapshot(row.optionSnapshot, { optionId: row.optionId, currencyCode: row.program.currencyCode }),
    termsVersion: row.termsVersion,
    effectiveFrom: row.effectiveFrom?.toISOString() ?? null,
    effectiveTo: row.effectiveTo?.toISOString() ?? null,
    upcoming: row.status === 'ACTIVE' && row.effectiveFrom !== null && row.effectiveFrom.getTime() > now.getTime(),
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    statusReason: row.statusReason,
    paymentRecordedAt: row.paymentRecordedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toMyEnrollmentDto(row: EnrollmentRow, now = new Date()): MyEnrollmentDto {
  return { ...base(row, now), canCancel: canCancel(row, now) };
}

export function toAdminEnrollmentDto(row: AdminEnrollmentRow, now = new Date()): AdminEnrollmentDto {
  return {
    ...base(row, now),
    member: { id: row.user.id, fullName: row.user.fullName, email: row.user.email },
    sponsor: row.sponsor ? { id: row.sponsor.id, fullName: row.sponsor.fullName } : null,
    paymentReference: row.paymentReference,
    paymentAmountMinor: row.paymentAmountMinor?.toString() ?? null,
    paymentRecordedBy: row.paymentRecordedBy ? { id: row.paymentRecordedBy.id, fullName: row.paymentRecordedBy.fullName } : null,
    updatedAt: row.updatedAt.toISOString(),
    allowedActions: adminEnrollmentActions(row, now),
  };
}
