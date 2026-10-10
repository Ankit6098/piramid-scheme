import { Injectable } from '@nestjs/common';
import type {
  ApiPage,
  ListMemberProgramsQuery,
  MemberProgramDetailDto,
  MemberProgramDto,
  MemberProgramEnrollmentRef,
} from '@app/shared';
import { z } from 'zod';
import { decodeCursor, notFound, paginate, PrismaService, type AuthContext } from '../../common';
import type { Prisma } from '../../generated/prisma/client';
import { evaluateEligibility, parseEligibility, type EligibilityMember } from '../enrollments/domain/enrollment-rules';
import { isEnrollmentWindowOpen } from './domain/program-rules';

const cursorSchema = z.object({ startsAt: z.iso.datetime(), id: z.uuid() });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const memberProgramInclude = {
  offering: { select: { name: true, kind: true, description: true } },
  options: {
    where: { isActive: true },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
  },
} satisfies Prisma.ProgramInclude;

type MemberProgramRow = Prisma.ProgramGetPayload<{ include: typeof memberProgramInclude }>;

/** Statuses members can browse. Other statuses are visible only to members enrolled in them. */
const BROWSABLE = ['ACTIVE', 'SCHEDULED'] as const;

/**
 * Member-facing catalogue: browsable programs with their active plans, enrollment window, terms and
 * the caller's own eligibility/enrollments. Never exposes reward policies, other members or admins.
 */
@Injectable()
export class MemberProgramsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(auth: AuthContext, query: ListMemberProgramsQuery): Promise<ApiPage<MemberProgramDto>> {
    const cursor = decodeCursor(query.cursor, cursorSchema);
    const where: Prisma.ProgramWhereInput = {
      status: { in: [...BROWSABLE] },
      options: { some: { isActive: true } },
      ...(cursor
        ? {
            OR: [
              { startsAt: { lt: new Date(cursor.startsAt) } },
              { startsAt: new Date(cursor.startsAt), id: { lt: cursor.id } },
            ],
          }
        : {}),
    };
    const rows = await this.prisma.program.findMany({
      where,
      include: memberProgramInclude,
      orderBy: [{ startsAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });
    const page = rows.slice(0, query.limit);
    const [member, enrollments] = await Promise.all([
      this.member(auth.userId),
      this.myEnrollments(auth.userId, page.map((p) => p.id)),
    ]);
    const now = new Date();
    return paginate(
      rows,
      query.limit,
      (r) => ({ startsAt: r.startsAt.toISOString(), id: r.id }),
      (r) => this.toDto(r, member, enrollments.get(r.id) ?? [], now),
    );
  }

  /** By id or code. Non-browsable programs are visible only to members with an enrollment in them. */
  async get(auth: AuthContext, idOrCode: string): Promise<MemberProgramDetailDto> {
    const where: Prisma.ProgramWhereUniqueInput = UUID.test(idOrCode) ? { id: idOrCode } : { code: idOrCode.toLowerCase() };
    const row = await this.prisma.program.findUnique({ where, include: memberProgramInclude });
    if (!row || row.status === 'DRAFT') throw notFound('Program');
    const [member, enrollments] = await Promise.all([this.member(auth.userId), this.myEnrollments(auth.userId, [row.id])]);
    const mine = enrollments.get(row.id) ?? [];
    if (!(BROWSABLE as readonly string[]).includes(row.status)) {
      const any = await this.prisma.programEnrollment.count({ where: { programId: row.id, userId: auth.userId } });
      if (any === 0) throw notFound('Program');
    }
    return { ...this.toDto(row, member, mine, new Date()), termsText: row.termsText };
  }

  private toDto(
    r: MemberProgramRow,
    member: EligibilityMember,
    myEnrollments: MemberProgramEnrollmentRef[],
    now: Date,
  ): MemberProgramDto {
    const eligibility = parseEligibility(r.eligibility);
    return {
      id: r.id,
      code: r.code,
      name: r.name,
      description: r.description,
      status: r.status,
      offering: { name: r.offering.name, kind: r.offering.kind, description: r.offering.description },
      currencyCode: r.currencyCode,
      currencyMinorUnits: r.currencyMinorUnits,
      timezone: r.timezone,
      startsAt: r.startsAt.toISOString(),
      endsAt: r.endsAt?.toISOString() ?? null,
      enrollmentOpensAt: r.enrollmentOpensAt.toISOString(),
      enrollmentClosesAt: r.enrollmentClosesAt?.toISOString() ?? null,
      enrollmentOpen: r.status === 'ACTIVE' && isEnrollmentWindowOpen(r, now),
      eligibility,
      myEligibility: evaluateEligibility(eligibility, member, now),
      termsVersion: r.termsVersion,
      options: r.options.map((o) => ({
        id: o.id,
        name: o.name,
        description: o.description,
        priceMinor: o.priceMinor.toString(),
        currencyCode: o.currencyCode,
        billingFrequency: o.billingFrequency,
        durationDays: o.durationDays,
        renewalPolicy: o.renewalPolicy,
      })),
      myEnrollments,
    };
  }

  private async member(userId: string): Promise<EligibilityMember> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { createdAt: true, sponsorRelationship: { select: { id: true } } },
    });
    return { createdAt: user.createdAt, hasSponsor: user.sponsorRelationship !== null };
  }

  private async myEnrollments(userId: string, programIds: string[]): Promise<Map<string, MemberProgramEnrollmentRef[]>> {
    const map = new Map<string, MemberProgramEnrollmentRef[]>();
    if (programIds.length === 0) return map;
    const rows = await this.prisma.programEnrollment.findMany({
      where: { userId, programId: { in: programIds }, status: { in: ['PENDING', 'ACTIVE'] } },
      select: { id: true, programId: true, status: true, optionSnapshot: true, effectiveFrom: true, effectiveTo: true },
      orderBy: [{ createdAt: 'asc' }],
    });
    for (const e of rows) {
      const snapshot = (e.optionSnapshot ?? {}) as { name?: unknown };
      const list = map.get(e.programId) ?? [];
      list.push({
        id: e.id,
        status: e.status,
        optionName: typeof snapshot.name === 'string' ? snapshot.name : 'Plan',
        effectiveFrom: e.effectiveFrom?.toISOString() ?? null,
        effectiveTo: e.effectiveTo?.toISOString() ?? null,
      });
      map.set(e.programId, list);
    }
    return map;
  }
}
