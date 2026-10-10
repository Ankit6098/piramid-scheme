import type {
  FinancePersonRef,
  LedgerEntryDto,
  LedgerTransactionDetailDto,
  LedgerTransactionDto,
} from '@app/shared';
import type { Prisma } from '../../generated/prisma/client';

export const PERSON_SELECT = { select: { id: true, fullName: true } } as const;

export function personRef(user: { id: string; fullName: string } | null | undefined): FinancePersonRef | null {
  return user ? { id: user.id, fullName: user.fullName } : null;
}

/** Relations needed to render a ledger transaction row. */
export const LEDGER_TRANSACTION_INCLUDE = {
  postedBy: PERSON_SELECT,
  reversedBy: { select: { id: true } },
  reward: {
    select: {
      id: true,
      level: true,
      status: true,
      eventId: true,
      programId: true,
      rewardUnit: true,
      currencyCode: true,
      recipient: PERSON_SELECT,
      program: { select: { id: true, name: true, currencyMinorUnits: true } },
    },
  },
} as const satisfies Prisma.LedgerTransactionInclude;

export const LEDGER_TRANSACTION_DETAIL_INCLUDE = {
  ...LEDGER_TRANSACTION_INCLUDE,
  entries: {
    // Enum order: DEBIT before CREDIT.
    orderBy: [{ direction: 'asc' }, { id: 'asc' }],
    include: { account: { select: { id: true, type: true, user: PERSON_SELECT } } },
  },
} as const satisfies Prisma.LedgerTransactionInclude;

export type LedgerTransactionRow = Prisma.LedgerTransactionGetPayload<{ include: typeof LEDGER_TRANSACTION_INCLUDE }>;
export type LedgerTransactionDetailRow = Prisma.LedgerTransactionGetPayload<{
  include: typeof LEDGER_TRANSACTION_DETAIL_INCLUDE;
}>;

export function toLedgerTransactionDto(row: LedgerTransactionRow): LedgerTransactionDto {
  const reward = row.reward;
  return {
    id: row.id,
    type: row.type,
    idempotencyKey: row.idempotencyKey,
    amountMinor: row.debitTotalMinor.toString(),
    entryCount: row.entryCount,
    rewardUnit: reward.rewardUnit,
    currencyCode: reward.currencyCode,
    currencyMinorUnits: reward.program.currencyMinorUnits,
    description: row.description,
    postedAt: row.postedAt.toISOString(),
    postedBy: personRef(row.postedBy),
    reward: { id: reward.id, level: reward.level, status: reward.status, eventId: reward.eventId },
    member: { id: reward.recipient.id, fullName: reward.recipient.fullName },
    program: { id: reward.program.id, name: reward.program.name },
    reversesTransactionId: row.reversesTransactionId,
    reversedByTransactionId: row.reversedBy?.id ?? null,
  };
}

export function toLedgerTransactionDetailDto(row: LedgerTransactionDetailRow): LedgerTransactionDetailDto {
  const minorUnits = row.reward.program.currencyMinorUnits;
  return {
    ...toLedgerTransactionDto(row),
    entries: row.entries.map(
      (e): LedgerEntryDto => ({
        id: e.id,
        accountId: e.accountId,
        accountType: e.account.type,
        accountOwner: personRef(e.account.user),
        direction: e.direction,
        amountMinor: e.amountMinor.toString(),
        rewardUnit: e.rewardUnit,
        currencyCode: e.currencyCode,
        currencyMinorUnits: minorUnits,
      }),
    ),
  };
}

/** Normal-side balance: liability accounts are credit-normal, the expense account debit-normal. */
export function normalBalance(type: 'MEMBER_REWARDS_PAYABLE' | 'PLATFORM_REWARD_EXPENSE', credits: bigint, debits: bigint): bigint {
  return type === 'MEMBER_REWARDS_PAYABLE' ? credits - debits : debits - credits;
}
