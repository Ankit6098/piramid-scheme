import { Injectable } from '@nestjs/common';
import {
  FlagKind,
  type ApiPage,
  type CreateFlagInput,
  type FlagDto,
  type ListFlagsQuery,
  type ResolveFlagInput,
} from '@app/shared';
import { z } from 'zod';
import { AuditService } from '../../common/audit/audit.service';
import type { AuthContext } from '../../common/auth/auth-context';
import { forbidden, invalidState, notFound } from '../../common/errors/app-error';
import { decodeCursor, paginate } from '../../common/pagination/cursor';
import { PrismaService, type Db } from '../../common/prisma/prisma.service';
import type { Prisma } from '../../generated/prisma/client';

const flagCursorSchema = z.object({ createdAt: z.iso.datetime(), id: z.uuid() });

const FLAG_SELECT = {
  id: true,
  kind: true,
  details: true,
  status: true,
  resolution: true,
  resolvedAt: true,
  createdAt: true,
  updatedAt: true,
  user: { select: { id: true, fullName: true, status: true } },
  createdBy: { select: { id: true, fullName: true } },
  resolvedBy: { select: { id: true, fullName: true } },
} satisfies Prisma.MemberFlagSelect;

type FlagRow = Prisma.MemberFlagGetPayload<{ select: typeof FLAG_SELECT }>;

/**
 * Suspicious-activity flags (business rules §12; `flags:manage`). Advisory only: flags never change
 * balances. Heuristic flags are raised by `FraudSignalsService`; admins raise manual reports and
 * resolve or dismiss flags — never their own (DB CHECK, mirrored here).
 */
@Injectable()
export class FlagsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(q: ListFlagsQuery): Promise<ApiPage<FlagDto>> {
    const c = decodeCursor(q.cursor, flagCursorSchema);
    const where: Prisma.MemberFlagWhereInput = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.kind ? { kind: q.kind } : {}),
      ...(q.userId ? { userId: q.userId } : {}),
      ...(c
        ? {
            OR: [
              { createdAt: { lt: new Date(c.createdAt) } },
              { createdAt: new Date(c.createdAt), id: { lt: c.id } },
            ],
          }
        : {}),
    };
    const rows = await this.prisma.memberFlag.findMany({
      where,
      select: FLAG_SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
    });
    return paginate(rows, q.limit, (r) => ({ createdAt: r.createdAt.toISOString(), id: r.id }), toFlagDto);
  }

  async get(id: string): Promise<FlagDto> {
    const row = await this.prisma.memberFlag.findUnique({ where: { id }, select: FLAG_SELECT });
    if (!row) throw notFound('Flag');
    return toFlagDto(row);
  }

  /** Raises a MANUAL_REPORT flag on a member. */
  async create(auth: AuthContext, input: CreateFlagInput): Promise<FlagDto> {
    return this.prisma.runInTransaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: input.userId }, select: { id: true } });
      if (!user) throw notFound('Member');
      const flag = await tx.memberFlag.create({
        data: { userId: input.userId, kind: FlagKind.ManualReport, details: input.details, createdById: auth.userId },
        select: FLAG_SELECT,
      });
      await this.audit.record(tx, {
        action: 'flag.create',
        resourceType: 'member_flag',
        resourceId: flag.id,
        after: { userId: input.userId, kind: FlagKind.ManualReport, status: 'OPEN' },
      });
      return toFlagDto(flag);
    });
  }

  /** OPEN → RESOLVED | DISMISSED with a resolution note (conditional update; not by the subject). */
  async resolve(auth: AuthContext, id: string, input: ResolveFlagInput): Promise<FlagDto> {
    return this.prisma.runInTransaction(async (tx) => {
      const flag = await tx.memberFlag.findUnique({ where: { id }, select: { id: true, userId: true, status: true } });
      if (!flag) throw notFound('Flag');
      if (flag.userId === auth.userId) throw forbidden('You cannot resolve a flag raised about yourself');
      const updated = await tx.memberFlag.updateMany({
        where: { id, status: 'OPEN' },
        data: { status: input.status, resolution: input.resolution, resolvedById: auth.userId, resolvedAt: new Date() },
      });
      if (updated.count !== 1) throw invalidState('Only open flags can be resolved', { status: flag.status });
      await this.audit.record(tx, {
        action: input.status === 'RESOLVED' ? 'flag.resolve' : 'flag.dismiss',
        resourceType: 'member_flag',
        resourceId: id,
        before: { status: 'OPEN' },
        after: { status: input.status },
        reason: input.resolution,
      });
      return toFlagDto(await loadFlag(tx, id));
    });
  }
}

async function loadFlag(db: Db, id: string): Promise<FlagRow> {
  return db.memberFlag.findUniqueOrThrow({ where: { id }, select: FLAG_SELECT });
}

function toFlagDto(r: FlagRow): FlagDto {
  return {
    id: r.id,
    kind: r.kind,
    details: r.details,
    status: r.status,
    user: { id: r.user.id, fullName: r.user.fullName, status: r.user.status },
    createdBy: r.createdBy ? { id: r.createdBy.id, fullName: r.createdBy.fullName } : null,
    resolvedBy: r.resolvedBy ? { id: r.resolvedBy.id, fullName: r.resolvedBy.fullName } : null,
    resolution: r.resolution,
    resolvedAt: r.resolvedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}
