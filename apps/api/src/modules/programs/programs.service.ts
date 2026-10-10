import { Injectable } from '@nestjs/common';
import {
  type AdminProgramDetailDto,
  type AdminProgramSummaryDto,
  type ApiPage,
  type CreateProgramInput,
  type EnrollmentStatus,
  type ListAdminProgramsQuery,
  type ProgramEditableField,
  type ProgramPolicySummary,
  type ProgramPolicyVersionRef,
  type UpdateProgramInput,
  createProgramSchema,
} from '@app/shared';
import { z } from 'zod';
import {
  assertProgramAccess,
  AuditService,
  conflict,
  decodeCursor,
  invalidState,
  notFound,
  paginate,
  PlatformSettingsService,
  PrismaService,
  programScopeFilter,
  programSnapshotFrom,
  staleVersion,
  validationFailed,
  type AuthContext,
  type Db,
} from '../../common';
import type { Prisma } from '../../generated/prisma/client';
import { parseEligibility } from '../enrollments/domain/enrollment-rules';
import { evaluatePublishChecks, validateProgramPatch, type ProgramPatchInput } from './domain/program-rules';
import { lockProgram } from './program-db';
import {
  programDetailInclude,
  programSummaryInclude,
  toProgramDetail,
  toProgramSummary,
  type EnrollmentHeadcount,
} from './programs.mapper';

const cursorSchema = z.object({ createdAt: z.iso.datetime(), id: z.uuid() });

type CreateProgramData = z.output<typeof createProgramSchema>;

const DATE_FIELDS = new Set<ProgramEditableField>(['startsAt', 'endsAt', 'enrollmentOpensAt', 'enrollmentClosesAt']);
const NULLABLE_TEXT = new Set<ProgramEditableField>(['description', 'termsText']);

function textOrNull(v: string | null | undefined): string | null {
  if (v === undefined || v === null) return null;
  const t = v.trim();
  return t === '' ? null : t;
}

function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

/** Audit-friendly value (dates → ISO). */
function auditValue(v: unknown): unknown {
  return v instanceof Date ? v.toISOString() : v;
}

function issuesError(issues: Array<{ path: string; message: string }>) {
  return validationFailed(issues[0]?.message ?? 'Some fields need attention', {
    issues: issues.map((i) => ({ path: i.path, message: i.message, code: 'custom' })),
  });
}

/**
 * Admin program use cases: list (scoped), detail, create (snapshots unit + currency), edit with
 * optimistic concurrency and status-dependent field rules, delete drafts (business rules §1, §4).
 */
@Injectable()
export class ProgramsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: PlatformSettingsService,
    private readonly audit: AuditService,
  ) {}

  async list(auth: AuthContext, query: ListAdminProgramsQuery): Promise<ApiPage<AdminProgramSummaryDto>> {
    const scope = programScopeFilter(auth, 'read');
    const cursor = decodeCursor(query.cursor, cursorSchema);
    const statuses = query.status === undefined ? undefined : Array.isArray(query.status) ? query.status : [query.status];
    const filters: Prisma.ProgramWhereInput[] = [];
    if (scope !== 'ALL') filters.push({ id: { in: scope } });
    if (statuses && statuses.length > 0) filters.push({ status: { in: statuses } });
    if (query.offeringId) filters.push({ offeringId: query.offeringId });
    if (query.q) {
      filters.push({ OR: [{ name: { contains: query.q, mode: 'insensitive' } }, { code: { contains: query.q.toLowerCase() } }] });
    }
    if (cursor) {
      filters.push({
        OR: [{ createdAt: { lt: new Date(cursor.createdAt) } }, { createdAt: new Date(cursor.createdAt), id: { lt: cursor.id } }],
      });
    }
    const rows = await this.prisma.program.findMany({
      where: { AND: filters },
      include: programSummaryInclude,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });
    const counts = await this.headcounts(this.prisma, rows.slice(0, query.limit).map((r) => r.id));
    return paginate(
      rows,
      query.limit,
      (r) => ({ createdAt: r.createdAt.toISOString(), id: r.id }),
      (r) => toProgramSummary(r, counts.get(r.id) ?? { active: 0, pending: 0 }),
    );
  }

  async getDetail(auth: AuthContext, id: string): Promise<AdminProgramDetailDto> {
    assertProgramAccess(auth, id, 'read');
    return this.loadDetail(this.prisma, id);
  }

  /** Detail DTO (no authorization — callers check access first). */
  async loadDetail(db: Db, id: string, now = new Date()): Promise<AdminProgramDetailDto> {
    const row = await db.program.findUnique({ where: { id }, include: programDetailInclude });
    if (!row) throw notFound('Program');
    // Sequential on purpose: `db` may be an interactive transaction (one connection).
    const enrollmentGroups = await db.programEnrollment.groupBy({ by: ['status'], where: { programId: id }, _count: { _all: true } });
    const policyGroups = await db.rewardPolicyVersion.groupBy({ by: ['status'], where: { programId: id }, _count: { _all: true } });
    const policyRef = { id: true, version: true, name: true, effectiveFrom: true, effectiveTo: true } as const;
    const current = await db.rewardPolicyVersion.findFirst({
      where: {
        programId: id,
        status: 'PUBLISHED',
        effectiveFrom: { lte: now },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
      },
      orderBy: { effectiveFrom: 'desc' },
      select: policyRef,
    });
    const upcoming = await db.rewardPolicyVersion.findFirst({
      where: { programId: id, status: 'PUBLISHED', effectiveFrom: { gt: now } },
      orderBy: { effectiveFrom: 'asc' },
      select: policyRef,
    });
    const apiClients = await db.apiClient.count({ where: { programId: id } });
    const policyCount = (s: string) => policyGroups.find((g) => g.status === s)?._count._all ?? 0;
    const ref = (p: typeof current): ProgramPolicyVersionRef | null =>
      p
        ? {
            id: p.id,
            version: p.version,
            name: p.name,
            effectiveFrom: p.effectiveFrom.toISOString(),
            effectiveTo: p.effectiveTo?.toISOString() ?? null,
          }
        : null;
    const policySummary: ProgramPolicySummary = {
      draftCount: policyCount('DRAFT'),
      publishedCount: policyCount('PUBLISHED'),
      retiredCount: policyCount('RETIRED'),
      current: ref(current),
      upcoming: ref(upcoming),
    };
    const enrollmentCounts = Object.fromEntries(enrollmentGroups.map((g) => [g.status, g._count._all])) as Partial<
      Record<EnrollmentStatus, number>
    >;
    const publishChecks = evaluatePublishChecks(
      {
        startsAt: row.startsAt,
        endsAt: row.endsAt,
        enrollmentOpensAt: row.enrollmentOpensAt,
        enrollmentClosesAt: row.enrollmentClosesAt,
        activeOptionCount: row._count.options,
        offeringStatus: row.offering.status,
        publishedPolicyCount: policySummary.publishedCount,
      },
      now,
    );
    const canDelete =
      row.status === 'DRAFT' && policySummary.publishedCount === 0 && policySummary.retiredCount === 0 && apiClients === 0;
    return toProgramDetail(row, { enrollmentCounts, policySummary, publishChecks, canDelete });
  }

  async create(auth: AuthContext, input: CreateProgramData): Promise<AdminProgramDetailDto> {
    return this.prisma.runInTransaction(async (tx) => {
      const offering = await tx.offering.findUnique({ where: { id: input.offeringId }, select: { id: true } });
      if (!offering) throw issuesError([{ path: 'offeringId', message: 'This offering does not exist' }]);
      await this.assertCodeFree(tx, input.code);
      const settings = await this.settings.get(tx);
      const program = await tx.program.create({
        data: {
          code: input.code,
          name: input.name,
          description: textOrNull(input.description),
          offeringId: input.offeringId,
          timezone: input.timezone,
          startsAt: new Date(input.startsAt),
          endsAt: input.endsAt ? new Date(input.endsAt) : null,
          enrollmentOpensAt: new Date(input.enrollmentOpensAt ?? input.startsAt),
          enrollmentClosesAt: input.enrollmentClosesAt ? new Date(input.enrollmentClosesAt) : null,
          maxRewardDepth: input.maxRewardDepth,
          lateEventGraceDays: input.lateEventGraceDays,
          eligibility: input.eligibility as Prisma.InputJsonValue,
          termsVersion: input.termsVersion,
          termsText: textOrNull(input.termsText),
          ...programSnapshotFrom(settings),
          status: 'DRAFT',
          createdById: auth.userId,
          updatedById: auth.userId,
        },
      });
      // A program admin who creates a program manages it (otherwise it would be out of their scope).
      const selfAssigned = !auth.roles.includes('SUPER_ADMIN') && auth.roles.includes('PROGRAM_ADMIN');
      if (selfAssigned) {
        await tx.programAdminAssignment.create({ data: { userId: auth.userId, programId: program.id } });
      }
      await this.audit.record(tx, {
        action: 'program.create',
        resourceType: 'program',
        resourceId: program.id,
        programId: program.id,
        after: {
          code: program.code,
          name: program.name,
          offeringId: program.offeringId,
          status: program.status,
          rewardUnit: program.rewardUnit,
          currencyCode: program.currencyCode,
          currencyMinorUnits: program.currencyMinorUnits,
          startsAt: program.startsAt.toISOString(),
          endsAt: program.endsAt?.toISOString() ?? null,
          creatorAssigned: selfAssigned,
        },
      });
      return this.loadDetail(tx, program.id);
    });
  }

  async update(auth: AuthContext, id: string, input: UpdateProgramInput): Promise<AdminProgramDetailDto> {
    assertProgramAccess(auth, id, 'write');
    return this.prisma.runInTransaction(async (tx) => {
      await lockProgram(tx, id);
      const current = await tx.program.findUniqueOrThrow({ where: { id } });
      if (current.version !== input.expectedVersion) throw staleVersion();
      const now = new Date();

      // Keep only fields that actually change (normalized), as Prisma data + audit values.
      const patch: ProgramPatchInput = {};
      const data: Record<string, unknown> = {};
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      const { expectedVersion: _v, reason, ...fields } = input;
      for (const [key, raw] of Object.entries(fields) as Array<[ProgramEditableField, unknown]>) {
        if (raw === undefined) continue;
        let next: unknown = raw;
        if (DATE_FIELDS.has(key)) next = raw === null ? null : new Date(raw as string);
        else if (NULLABLE_TEXT.has(key)) next = textOrNull(raw as string | null);
        const prev: unknown = (current as Record<string, unknown>)[key];
        const same =
          key === 'eligibility'
            ? stableJson(parseEligibility(prev)) === stableJson(next)
            : next instanceof Date || prev instanceof Date
              ? (next as Date | null)?.getTime() === (prev as Date | null)?.getTime()
              : next === prev;
        if (same) continue;
        if (next === null && !DATE_FIELDS.has(key) && !NULLABLE_TEXT.has(key)) continue;
        patch[key] = next instanceof Date ? next.toISOString() : next;
        data[key] = next;
        before[key] = auditValue(key === 'eligibility' ? parseEligibility(prev) : prev);
        after[key] = auditValue(next);
      }
      if (Object.keys(data).length === 0) return this.loadDetail(tx, id, now);

      const { notEditable, issues } = validateProgramPatch(current, patch, now);
      if (notEditable.length > 0) {
        throw invalidState(
          `These fields can't change while the program is ${current.status.toLowerCase()}: ${notEditable.join(', ')}`,
          { status: current.status, fields: notEditable },
        );
      }
      if (issues.length > 0) throw issuesError(issues);

      if (typeof data.offeringId === 'string') {
        const offering = await tx.offering.findUnique({ where: { id: data.offeringId }, select: { id: true } });
        if (!offering) throw issuesError([{ path: 'offeringId', message: 'This offering does not exist' }]);
      }
      if (typeof data.code === 'string') await this.assertCodeFree(tx, data.code, id);
      if (typeof data.maxRewardDepth === 'number') {
        const deeper = await tx.rewardPolicyVersion.count({
          where: { programId: id, status: { not: 'DRAFT' }, maxDepth: { gt: data.maxRewardDepth } },
        });
        if (deeper > 0) {
          throw issuesError([{ path: 'maxRewardDepth', message: 'A published reward policy uses more levels than this' }]);
        }
      }

      await tx.program.update({
        where: { id },
        data: { ...(data as Prisma.ProgramUncheckedUpdateInput), updatedById: auth.userId },
      });
      await this.audit.record(tx, {
        action: 'program.update',
        resourceType: 'program',
        resourceId: id,
        programId: id,
        before,
        after,
        reason: reason ?? null,
      });
      return this.loadDetail(tx, id, now);
    });
  }

  /** Only DRAFT programs without published/retired policy versions or API clients can be deleted. */
  async delete(auth: AuthContext, id: string): Promise<void> {
    assertProgramAccess(auth, id, 'write');
    await this.prisma.runInTransaction(async (tx) => {
      const locked = await lockProgram(tx, id);
      if (locked.status !== 'DRAFT') {
        throw invalidState('Only draft programs can be deleted. Complete and archive it instead.', { status: locked.status });
      }
      const policies = await tx.rewardPolicyVersion.count({ where: { programId: id, status: { not: 'DRAFT' } } });
      const apiClients = await tx.apiClient.count({ where: { programId: id } });
      if (policies > 0) throw invalidState('This draft has published reward policy versions and cannot be deleted', { policies });
      if (apiClients > 0) throw invalidState('Revoke and remove the API clients of this program first', { apiClients });
      const program = await tx.program.findUniqueOrThrow({ where: { id }, select: { code: true, name: true } });
      await tx.program.delete({ where: { id } });
      await this.audit.record(tx, {
        action: 'program.delete',
        resourceType: 'program',
        resourceId: id,
        programId: id,
        before: { code: program.code, name: program.name, status: 'DRAFT' },
      });
    });
  }

  /** Active/pending enrollment counts per program. */
  async headcounts(db: Db, programIds: string[]): Promise<Map<string, EnrollmentHeadcount>> {
    const map = new Map<string, EnrollmentHeadcount>();
    if (programIds.length === 0) return map;
    const groups = await db.programEnrollment.groupBy({
      by: ['programId', 'status'],
      where: { programId: { in: programIds }, status: { in: ['ACTIVE', 'PENDING'] } },
      _count: { _all: true },
    });
    for (const g of groups) {
      const entry = map.get(g.programId) ?? { active: 0, pending: 0 };
      if (g.status === 'ACTIVE') entry.active = g._count._all;
      else entry.pending = g._count._all;
      map.set(g.programId, entry);
    }
    return map;
  }

  private async assertCodeFree(tx: Db, code: string, exceptId?: string): Promise<void> {
    const existing = await tx.program.findUnique({ where: { code }, select: { id: true } });
    if (existing && existing.id !== exceptId) {
      throw conflict('Another program already uses this code', {
        issues: [{ path: 'code', message: 'This code is already used by another program', code: 'custom' }],
      });
    }
  }
}

