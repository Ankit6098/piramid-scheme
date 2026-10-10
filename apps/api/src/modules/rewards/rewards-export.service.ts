import { Injectable } from '@nestjs/common';
import { minorToDecimalString, type AdminRewardExportQuery, type MemberRewardFilters } from '@app/shared';
import { AuditService } from '../../common/audit/audit.service';
import type { AuthContext } from '../../common/auth/auth-context';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import { CSV_BOM, csvRow } from '../ledger/domain/csv';
import type { CsvSink } from '../ledger/ledger-query.service';
import { ADMIN_REWARD_INCLUDE, MEMBER_REWARD_SELECT, toMemberReward } from './reward-mappers';
import { createdAtKeyset, RewardsQueryService } from './rewards-query.service';

const BATCH = 500;

type PageArgs = { where: Prisma.RewardWhereInput; orderBy: Prisma.RewardOrderByWithRelationInput[]; take: number };

const amount = (value: bigint, unit: 'MONEY' | 'POINTS', minorUnits: number) =>
  minorToDecimalString(value, unit === 'POINTS' ? 0 : minorUnits);

/** Streamed, CSV-injection-safe reward exports (admin: audited; member: own rewards only). */
@Injectable()
export class RewardsExportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly query: RewardsQueryService,
    private readonly audit: AuditService,
  ) {}

  /** Authorizes the filters (program scope) and records the export before any byte is sent. */
  async beginAdminExport(auth: AuthContext, q: AdminRewardExportQuery): Promise<Prisma.RewardWhereInput> {
    const where = this.query.adminWhere(auth, q);
    await this.audit.record(this.prisma, {
      action: 'rewards.export',
      resourceType: 'report',
      resourceId: 'rewards',
      programId: q.programId ?? null,
      after: { filters: q },
    });
    return where;
  }

  async exportAdmin(where: Prisma.RewardWhereInput, order: 'asc' | 'desc', sink: CsvSink): Promise<number> {
    await sink.write(
      CSV_BOM +
        csvRow([
          'reward_id',
          'created_at',
          'status',
          'program_code',
          'program_name',
          'level',
          'recipient_id',
          'recipient_name',
          'amount',
          'amount_minor',
          'reward_unit',
          'currency_code',
          'event_id',
          'sale_external_id',
          'sale_type',
          'sale_source',
          'sale_amount',
          'sale_currency',
          'sale_occurred_at',
          'subject_id',
          'subject_name',
          'approved_at',
          'approved_by_id',
          'posted_at',
          'rejected_at',
          'rejected_by_id',
          'rejection_reason',
          'reversed_at',
          'reversed_by_id',
          'reversal_reason',
        ]),
    );
    const fetch = (args: PageArgs) => this.prisma.reward.findMany({ ...args, include: ADMIN_REWARD_INCLUDE });
    return this.paged(where, order, fetch, sink, (r) => {
      const minor = r.program.currencyMinorUnits;
      return csvRow([
        r.id,
        r.createdAt,
        r.status,
        r.program.code,
        r.program.name,
        r.level,
        r.recipient.id,
        r.recipient.fullName,
        amount(r.amountMinor, r.rewardUnit, minor),
        r.amountMinor,
        r.rewardUnit,
        r.currencyCode,
        r.event.id,
        r.event.externalId,
        r.event.type,
        r.event.source,
        minorToDecimalString(r.event.amountMinor, minor),
        r.event.currencyCode,
        r.event.occurredAt,
        r.event.subject.id,
        r.event.subject.fullName,
        r.approvedAt,
        r.approvedBy?.id ?? null,
        r.postedAt,
        r.rejectedAt,
        r.rejectedBy?.id ?? null,
        r.rejectionReason,
        r.reversedAt,
        r.reversedBy?.id ?? null,
        r.reversalReason,
      ]);
    });
  }

  /** A member's own rewards with exactly the §10 fields (no sale details). */
  async exportMine(auth: AuthContext, filters: MemberRewardFilters, sink: CsvSink): Promise<number> {
    await sink.write(
      CSV_BOM +
        csvRow([
          'reward_id',
          'date',
          'program',
          'level',
          'amount',
          'reward_unit',
          'currency_code',
          'status',
          'approved_date',
          'posted_date',
          'rejected_date',
          'reversed_date',
          'rejection_reason',
          'reversal_reason',
        ]),
    );
    const fetch = (args: PageArgs) => this.prisma.reward.findMany({ ...args, select: MEMBER_REWARD_SELECT });
    return this.paged(this.query.memberWhere(auth.userId, filters), 'desc', fetch, sink, (row) => {
      const r = toMemberReward(row);
      return csvRow([
        r.id,
        r.createdDate,
        r.program.name,
        r.level,
        amount(BigInt(r.amountMinor), r.rewardUnit, r.currencyMinorUnits),
        r.rewardUnit,
        r.currencyCode,
        r.status,
        r.approvedDate,
        r.postedDate,
        r.rejectedDate,
        r.reversedDate,
        r.rejectionReason,
        r.reversalReason,
      ]);
    });
  }

  private async paged<T extends { createdAt: Date; id: string }>(
    where: Prisma.RewardWhereInput,
    order: 'asc' | 'desc',
    fetch: (args: { where: Prisma.RewardWhereInput; orderBy: Prisma.RewardOrderByWithRelationInput[]; take: number }) => Promise<T[]>,
    sink: CsvSink,
    toLine: (row: T) => string,
  ): Promise<number> {
    let cursor: { createdAt: Date; id: string } | null = null;
    let count = 0;
    for (;;) {
      const page: Prisma.RewardWhereInput[] = [where];
      if (cursor) page.push(createdAtKeyset(cursor, order));
      const rows = await fetch({ where: { AND: page }, orderBy: [{ createdAt: order }, { id: order }], take: BATCH });
      if (rows.length === 0) break;
      await sink.write(rows.map(toLine).join(''));
      count += rows.length;
      const last = rows[rows.length - 1]!;
      cursor = { createdAt: last.createdAt, id: last.id };
      if (rows.length < BATCH) break;
    }
    return count;
  }
}
