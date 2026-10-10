import type {
  AdminRewardEventDto,
  AdminRewardRowDto,
  FinanceProgramRef,
  MemberRewardDto,
} from '@app/shared';
import type { Prisma } from '../../generated/prisma/client';
import { PERSON_SELECT, personRef } from '../ledger/ledger-mappers';
import { calendarDate } from './domain/member-view';

export const PROGRAM_REF_SELECT = {
  select: { id: true, name: true, code: true, timezone: true, currencyMinorUnits: true },
} as const;

/** Relations needed for an admin reward row. */
export const ADMIN_REWARD_INCLUDE = {
  program: PROGRAM_REF_SELECT,
  recipient: PERSON_SELECT,
  approvedBy: PERSON_SELECT,
  rejectedBy: PERSON_SELECT,
  reversedBy: PERSON_SELECT,
  event: {
    select: {
      id: true,
      externalId: true,
      revision: true,
      type: true,
      source: true,
      status: true,
      amountMinor: true,
      currencyCode: true,
      occurredAt: true,
      recordedById: true,
      subject: PERSON_SELECT,
      recordedBy: PERSON_SELECT,
    },
  },
} as const satisfies Prisma.RewardInclude;

export type AdminRewardRow = Prisma.RewardGetPayload<{ include: typeof ADMIN_REWARD_INCLUDE }>;

export function toProgramRef(p: { id: string; name: string; code: string; timezone: string }): FinanceProgramRef {
  return { id: p.id, name: p.name, code: p.code, timezone: p.timezone };
}

export function toAdminRewardEvent(e: AdminRewardRow['event']): AdminRewardEventDto {
  return {
    id: e.id,
    externalId: e.externalId,
    revision: e.revision,
    type: e.type,
    source: e.source,
    status: e.status,
    amountMinor: e.amountMinor.toString(),
    currencyCode: e.currencyCode,
    occurredAt: e.occurredAt.toISOString(),
    subject: { id: e.subject.id, fullName: e.subject.fullName },
    recordedBy: personRef(e.recordedBy),
  };
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function toAdminRewardRow(row: AdminRewardRow, viewerId: string): AdminRewardRowDto {
  return {
    id: row.id,
    status: row.status,
    level: row.level,
    amountMinor: row.amountMinor.toString(),
    rewardUnit: row.rewardUnit,
    currencyCode: row.currencyCode,
    currencyMinorUnits: row.program.currencyMinorUnits,
    program: toProgramRef(row.program),
    recipient: { id: row.recipient.id, fullName: row.recipient.fullName },
    event: toAdminRewardEvent(row.event),
    createdAt: row.createdAt.toISOString(),
    approvedAt: iso(row.approvedAt),
    approvedBy: personRef(row.approvedBy),
    postedAt: iso(row.postedAt),
    rejectedAt: iso(row.rejectedAt),
    rejectedBy: personRef(row.rejectedBy),
    rejectionReason: row.rejectionReason,
    reversedAt: iso(row.reversedAt),
    reversedBy: personRef(row.reversedBy),
    reversalReason: row.reversalReason,
    viewer: {
      isRecipient: row.recipientUserId === viewerId,
      recordedSale: row.event.recordedById === viewerId,
    },
  };
}

/** Columns a member's own reward view may read — never the event, its subject or the trace. */
export const MEMBER_REWARD_SELECT = {
  id: true,
  level: true,
  amountMinor: true,
  rewardUnit: true,
  currencyCode: true,
  status: true,
  createdAt: true,
  approvedAt: true,
  postedAt: true,
  rejectedAt: true,
  reversedAt: true,
  rejectionReason: true,
  reversalReason: true,
  program: { select: { id: true, name: true, timezone: true, currencyMinorUnits: true } },
} as const satisfies Prisma.RewardSelect;

export type MemberRewardRow = Prisma.RewardGetPayload<{ select: typeof MEMBER_REWARD_SELECT }>;

/** Business rules §10: program, level, amount, status, calendar dates and decision reasons only. */
export function toMemberReward(row: MemberRewardRow): MemberRewardDto {
  const tz = row.program.timezone;
  return {
    id: row.id,
    program: { id: row.program.id, name: row.program.name },
    level: row.level,
    amountMinor: row.amountMinor.toString(),
    rewardUnit: row.rewardUnit,
    currencyCode: row.currencyCode,
    currencyMinorUnits: row.program.currencyMinorUnits,
    status: row.status,
    createdDate: calendarDate(row.createdAt, tz)!,
    approvedDate: calendarDate(row.approvedAt, tz),
    postedDate: calendarDate(row.postedAt, tz),
    rejectedDate: calendarDate(row.rejectedAt, tz),
    reversedDate: calendarDate(row.reversedAt, tz),
    rejectionReason: row.rejectionReason,
    reversalReason: row.reversalReason,
  };
}
