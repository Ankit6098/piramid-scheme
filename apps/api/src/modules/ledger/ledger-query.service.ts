import { Injectable } from '@nestjs/common';
import {
  minorToDecimalString,
  type ApiPage,
  type LedgerAccountDto,
  type LedgerAccountListQuery,
  type LedgerExportQuery,
  type LedgerSummaryBucketDto,
  type LedgerSummaryDto,
  type LedgerTransactionDetailDto,
  type LedgerTransactionDto,
  type LedgerTransactionFilters,
  type LedgerTransactionListQuery,
} from '@app/shared';
import { z } from 'zod';
import { AuditService } from '../../common/audit/audit.service';
import type { AuthContext } from '../../common/auth/auth-context';
import { assertProgramAccess, programScopeFilter } from '../../common/auth/program-access';
import { forbidden, notFound } from '../../common/errors/app-error';
import { decodeCursor, paginate } from '../../common/pagination/cursor';
import { PrismaService, type Db } from '../../common/prisma/prisma.service';
import { Prisma, type LedgerAccountType, type RewardUnit } from '../../generated/prisma/client';
import { CSV_BOM, csvRow } from './domain/csv';
import { resolveDateRange } from './domain/date-range';
import {
  LEDGER_TRANSACTION_DETAIL_INCLUDE,
  LEDGER_TRANSACTION_INCLUDE,
  normalBalance,
  toLedgerTransactionDetailDto,
  toLedgerTransactionDto,
} from './ledger-mappers';

/** Where streamed CSV goes (the controller adapts the HTTP response). */
export interface CsvSink {
  write(chunk: string): Promise<void>;
}

const txnCursorSchema = z.object({ postedAt: z.iso.datetime(), id: z.uuid() });
const accountCursorSchema = z.object({ createdAt: z.iso.datetime(), id: z.uuid() });

const EXPORT_BATCH = 500;

interface AccountRow {
  id: string;
  type: LedgerAccountType;
  user_id: string | null;
  full_name: string | null;
  reward_unit: RewardUnit;
  currency_code: string;
  minor_units: number | null;
  credits_minor: bigint;
  debits_minor: bigint;
  created_at: Date;
}

/**
 * Read side of the ledger (business rules §9, §11): transactions with entries, account balances
 * (from the `ledger_account_balances` view), per unit/currency totals and the CSV export.
 * Writes stay in `LedgerService`.
 */
@Injectable()
export class LedgerQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ─── Transactions ───────────────────────────────────────────────────────

  async listTransactions(auth: AuthContext, q: LedgerTransactionListQuery): Promise<ApiPage<LedgerTransactionDto>> {
    const cursor = decodeCursor(q.cursor, txnCursorSchema);
    const where: Prisma.LedgerTransactionWhereInput = { AND: [this.transactionWhere(auth, q)] };
    if (cursor) {
      const at = new Date(cursor.postedAt);
      (where.AND as Prisma.LedgerTransactionWhereInput[]).push({
        OR: [{ postedAt: { lt: at } }, { postedAt: at, id: { lt: cursor.id } }],
      });
    }
    const rows = await this.prisma.ledgerTransaction.findMany({
      where,
      include: LEDGER_TRANSACTION_INCLUDE,
      orderBy: [{ postedAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
    });
    return paginate(rows, q.limit, (r) => ({ postedAt: r.postedAt.toISOString(), id: r.id }), toLedgerTransactionDto);
  }

  async getTransaction(auth: AuthContext, id: string): Promise<LedgerTransactionDetailDto> {
    const row = await this.prisma.ledgerTransaction.findUnique({ where: { id }, include: LEDGER_TRANSACTION_DETAIL_INCLUDE });
    if (!row) throw notFound('Ledger transaction');
    assertProgramAccess(auth, row.reward.programId, 'read');
    return toLedgerTransactionDetailDto(row);
  }

  /** Posting and reversal of one reward, with entries (caller has authorized the reward). */
  async transactionsForReward(db: Db, rewardId: string): Promise<LedgerTransactionDetailDto[]> {
    const rows = await db.ledgerTransaction.findMany({
      where: { rewardId },
      include: LEDGER_TRANSACTION_DETAIL_INCLUDE,
      orderBy: [{ postedAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map(toLedgerTransactionDetailDto);
  }

  // ─── Accounts ───────────────────────────────────────────────────────────

  async listAccounts(auth: AuthContext, q: LedgerAccountListQuery): Promise<ApiPage<LedgerAccountDto>> {
    this.assertGlobalScope(auth);
    const cursor = decodeCursor(q.cursor, accountCursorSchema);
    const conditions: Prisma.Sql[] = [];
    if (q.type) conditions.push(Prisma.sql`b."type" = ${q.type}::"LedgerAccountType"`);
    if (q.memberId) conditions.push(Prisma.sql`b."user_id" = ${q.memberId}::uuid`);
    if (q.rewardUnit) conditions.push(Prisma.sql`b."reward_unit" = ${q.rewardUnit}::"RewardUnit"`);
    if (q.currencyCode) conditions.push(Prisma.sql`b."currency_code" = ${q.currencyCode}`);
    if (q.nonZero) conditions.push(Prisma.sql`b."credits_minor" <> b."debits_minor"`);
    if (cursor) {
      const at = new Date(cursor.createdAt);
      conditions.push(Prisma.sql`(a."created_at" > ${at} OR (a."created_at" = ${at} AND a."id" > ${cursor.id}::uuid))`);
    }
    const where = conditions.length ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}` : Prisma.empty;
    const rows = await this.prisma.$queryRaw<AccountRow[]>`
      SELECT b."account_id" AS "id", b."type", b."user_id", u."full_name", b."reward_unit", b."currency_code",
             c."minor_units", b."credits_minor", b."debits_minor", a."created_at"
        FROM "ledger_account_balances" b
        JOIN "ledger_accounts" a ON a."id" = b."account_id"
        LEFT JOIN "users" u ON u."id" = b."user_id"
        LEFT JOIN "currencies" c ON c."code" = b."currency_code"
        ${where}
       ORDER BY a."created_at" ASC, a."id" ASC
       LIMIT ${q.limit + 1}`;
    return paginate(rows, q.limit, (r) => ({ createdAt: r.created_at.toISOString(), id: r.id }), (r) => ({
      id: r.id,
      type: r.type,
      owner: r.user_id ? { id: r.user_id, fullName: r.full_name ?? '' } : null,
      rewardUnit: r.reward_unit,
      currencyCode: r.currency_code,
      currencyMinorUnits: r.minor_units ?? 0,
      creditsMinor: r.credits_minor.toString(),
      debitsMinor: r.debits_minor.toString(),
      balanceMinor: normalBalance(r.type, r.credits_minor, r.debits_minor).toString(),
      createdAt: r.created_at.toISOString(),
    }));
  }

  // ─── Summary ────────────────────────────────────────────────────────────

  /** Per unit/currency: total posted, total reversed, outstanding member liability. */
  async summary(auth: AuthContext): Promise<LedgerSummaryDto> {
    this.assertGlobalScope(auth);
    const [txnTotals, balanceTotals, currencies] = await Promise.all([
      this.prisma.$queryRaw<Array<{ type: string; reward_unit: RewardUnit; currency_code: string; n: number; total: bigint }>>`
        SELECT t."type"::text AS "type", r."reward_unit", r."currency_code", count(*)::int AS "n",
               coalesce(sum(t."debit_total_minor"), 0)::bigint AS "total"
          FROM "ledger_transactions" t JOIN "rewards" r ON r."id" = t."reward_id"
         GROUP BY t."type", r."reward_unit", r."currency_code"`,
      this.prisma.$queryRaw<
        Array<{ type: LedgerAccountType; reward_unit: RewardUnit; currency_code: string; accounts: number; credits: bigint; debits: bigint }>
      >`
        SELECT "type", "reward_unit", "currency_code", count(*)::int AS "accounts",
               coalesce(sum("credits_minor"), 0)::bigint AS "credits", coalesce(sum("debits_minor"), 0)::bigint AS "debits"
          FROM "ledger_account_balances"
         GROUP BY "type", "reward_unit", "currency_code"`,
      this.minorUnitsByCurrency(),
    ]);

    const buckets = new Map<string, LedgerSummaryBucketDto & { _posted: bigint; _reversed: bigint; _liability: bigint; _expense: bigint }>();
    const bucket = (unit: RewardUnit, currency: string) => {
      const key = `${unit}:${currency}`;
      let b = buckets.get(key);
      if (!b) {
        b = {
          rewardUnit: unit,
          currencyCode: currency,
          currencyMinorUnits: currencies.get(currency) ?? 0,
          postedMinor: '0',
          postedCount: 0,
          reversedMinor: '0',
          reversedCount: 0,
          outstandingLiabilityMinor: '0',
          expenseMinor: '0',
          memberAccounts: 0,
          _posted: 0n,
          _reversed: 0n,
          _liability: 0n,
          _expense: 0n,
        };
        buckets.set(key, b);
      }
      return b;
    };
    let transactionCount = 0;
    for (const t of txnTotals) {
      const b = bucket(t.reward_unit, t.currency_code);
      transactionCount += t.n;
      if (t.type === 'REWARD_POSTING') {
        b._posted += t.total;
        b.postedCount += t.n;
      } else {
        b._reversed += t.total;
        b.reversedCount += t.n;
      }
    }
    for (const a of balanceTotals) {
      const b = bucket(a.reward_unit, a.currency_code);
      if (a.type === 'MEMBER_REWARDS_PAYABLE') {
        b._liability += a.credits - a.debits;
        b.memberAccounts += a.accounts;
      } else {
        b._expense += a.debits - a.credits;
      }
    }
    return {
      transactionCount,
      buckets: [...buckets.values()]
        .sort((x, y) => `${x.rewardUnit}${x.currencyCode}`.localeCompare(`${y.rewardUnit}${y.currencyCode}`))
        .map(({ _posted, _reversed, _liability, _expense, ...b }) => ({
          ...b,
          postedMinor: _posted.toString(),
          reversedMinor: _reversed.toString(),
          outstandingLiabilityMinor: _liability.toString(),
          expenseMinor: _expense.toString(),
        })),
    };
  }

  // ─── CSV export ─────────────────────────────────────────────────────────

  /** Validates access and records the (audited) export before any byte is streamed. */
  async beginExport(auth: AuthContext, q: LedgerExportQuery): Promise<void> {
    if (q.programId) assertProgramAccess(auth, q.programId, 'read');
    await this.audit.record(this.prisma, {
      action: 'ledger.export',
      resourceType: 'report',
      resourceId: 'ledger-entries',
      after: { filters: q },
    });
  }

  /** One CSV row per ledger entry, in keyset batches. */
  async exportCsv(auth: AuthContext, q: LedgerExportQuery, sink: CsvSink): Promise<number> {
    await sink.write(
      CSV_BOM +
        csvRow([
          'transaction_id',
          'posted_at',
          'transaction_type',
          'reward_id',
          'event_id',
          'program_id',
          'program_name',
          'member_id',
          'member_name',
          'account_id',
          'account_type',
          'direction',
          'amount',
          'amount_minor',
          'reward_unit',
          'currency_code',
          'description',
          'posted_by_id',
        ]),
    );
    const base = this.transactionWhere(auth, q);
    const desc = q.order !== 'asc';
    let cursor: { postedAt: Date; id: string } | null = null;
    let count = 0;
    for (;;) {
      const page: Prisma.LedgerTransactionWhereInput[] = [base];
      if (cursor) {
        page.push({
          OR: [
            { postedAt: desc ? { lt: cursor.postedAt } : { gt: cursor.postedAt } },
            { postedAt: cursor.postedAt, id: desc ? { lt: cursor.id } : { gt: cursor.id } },
          ],
        });
      }
      const rows = await this.prisma.ledgerTransaction.findMany({
        where: { AND: page },
        include: LEDGER_TRANSACTION_DETAIL_INCLUDE,
        orderBy: [{ postedAt: desc ? 'desc' : 'asc' }, { id: desc ? 'desc' : 'asc' }],
        take: EXPORT_BATCH,
      });
      if (rows.length === 0) break;
      let chunk = '';
      for (const t of rows) {
        const minor = t.reward.rewardUnit === 'POINTS' ? 0 : t.reward.program.currencyMinorUnits;
        for (const e of t.entries) {
          chunk += csvRow([
            t.id,
            t.postedAt,
            t.type,
            t.rewardId,
            t.reward.eventId,
            t.reward.program.id,
            t.reward.program.name,
            t.reward.recipient.id,
            t.reward.recipient.fullName,
            e.accountId,
            e.account.type,
            e.direction,
            minorToDecimalString(e.amountMinor, minor),
            e.amountMinor,
            e.rewardUnit,
            e.currencyCode,
            t.description,
            t.postedById,
          ]);
          count += 1;
        }
      }
      await sink.write(chunk);
      const last = rows[rows.length - 1]!;
      cursor = { postedAt: last.postedAt, id: last.id };
      if (rows.length < EXPORT_BATCH) break;
    }
    return count;
  }

  // ─── helpers ────────────────────────────────────────────────────────────

  async minorUnitsByCurrency(db: Db = this.prisma): Promise<Map<string, number>> {
    const rows = await db.currency.findMany({ select: { code: true, minorUnits: true } });
    return new Map(rows.map((c) => [c.code, c.minorUnits]));
  }

  private transactionWhere(auth: AuthContext, q: LedgerTransactionFilters): Prisma.LedgerTransactionWhereInput {
    const scope = programScopeFilter(auth, 'read');
    if (q.programId) assertProgramAccess(auth, q.programId, 'read');
    const programFilter = q.programId ? q.programId : scope === 'ALL' ? undefined : { in: scope };
    const reward: Prisma.RewardWhereInput = {};
    if (programFilter) reward.programId = programFilter;
    if (q.memberId) reward.recipientUserId = q.memberId;
    const where: Prisma.LedgerTransactionWhereInput = {};
    if (q.type) where.type = q.type;
    if (q.rewardId) where.rewardId = q.rewardId;
    const postedAt = resolveDateRange(q.from, q.to);
    if (postedAt) where.postedAt = postedAt;
    if (Object.keys(reward).length) where.reward = reward;
    return where;
  }

  /** Accounts and totals span every program: only roles with global read may see them. */
  private assertGlobalScope(auth: AuthContext): void {
    if (programScopeFilter(auth, 'read') !== 'ALL') {
      throw forbidden('Ledger balances span all programs and are available to finance reviewers only');
    }
  }
}
