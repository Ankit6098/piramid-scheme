import { Injectable } from '@nestjs/common';
import {
  LIVE_PROGRAM_STATUSES,
  Permission,
  type ApiPage,
  type CreateOfferingInput,
  type ListOfferingsQuery,
  type OfferingDto,
  type UpdateOfferingInput,
} from '@app/shared';
import { z } from 'zod';
import {
  AuditService,
  conflict,
  decodeCursor,
  forbidden,
  invalidState,
  notFound,
  paginate,
  PrismaService,
  type AuthContext,
  type Db,
} from '../../common';
import type { Prisma } from '../../generated/prisma/client';

const offeringInclude = {
  createdBy: { select: { id: true, fullName: true } },
  approvedBy: { select: { id: true, fullName: true } },
  _count: { select: { programs: true } },
} satisfies Prisma.OfferingInclude;

type OfferingRow = Prisma.OfferingGetPayload<{ include: typeof offeringInclude }>;

const cursorSchema = z.object({ createdAt: z.iso.datetime(), id: z.uuid() });

/** Fields recorded in the audit log (allow-list). */
const AUDITED = ['name', 'description', 'kind', 'sku', 'status'] as const;

function toDto(row: OfferingRow, liveProgramCount: number): OfferingDto {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    kind: row.kind,
    sku: row.sku,
    status: row.status,
    approvedAt: row.approvedAt?.toISOString() ?? null,
    approvedBy: row.approvedBy ? { id: row.approvedBy.id, fullName: row.approvedBy.fullName } : null,
    createdBy: row.createdBy ? { id: row.createdBy.id, fullName: row.createdBy.fullName } : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    programCount: row._count.programs,
    liveProgramCount,
  };
}

/** "" / undefined / null → null for optional text columns. */
function emptyToNull(v: string | null | undefined): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const t = v.trim();
  return t === '' ? null : t;
}

/**
 * Offerings (approved products/services) — business rules §4. New offerings are INACTIVE; only an
 * `offerings:approve` holder activates them (the DB requires an approver on ACTIVE rows).
 */
@Injectable()
export class OfferingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(query: ListOfferingsQuery): Promise<ApiPage<OfferingDto>> {
    const cursor = decodeCursor(query.cursor, cursorSchema);
    const where: Prisma.OfferingWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.kind ? { kind: query.kind } : {}),
      ...(query.q
        ? { OR: [{ name: { contains: query.q, mode: 'insensitive' } }, { sku: { contains: query.q, mode: 'insensitive' } }] }
        : {}),
    };
    const rows = await this.prisma.offering.findMany({
      where: cursor
        ? {
            AND: [
              where,
              { OR: [{ createdAt: { lt: new Date(cursor.createdAt) } }, { createdAt: new Date(cursor.createdAt), id: { lt: cursor.id } }] },
            ],
          }
        : where,
      include: offeringInclude,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });
    const live = await this.liveCounts(this.prisma, rows.map((r) => r.id));
    return paginate(
      rows,
      query.limit,
      (r) => ({ createdAt: r.createdAt.toISOString(), id: r.id }),
      (r) => toDto(r, live.get(r.id) ?? 0),
    );
  }

  async get(id: string, db: Db = this.prisma): Promise<OfferingDto> {
    const row = await db.offering.findUnique({ where: { id }, include: offeringInclude });
    if (!row) throw notFound('Offering');
    const live = await this.liveCounts(db, [id]);
    return toDto(row, live.get(id) ?? 0);
  }

  async create(auth: AuthContext, input: CreateOfferingInput): Promise<OfferingDto> {
    const sku = emptyToNull(input.sku) ?? null;
    return this.prisma.runInTransaction(async (tx) => {
      if (sku) await this.assertSkuFree(tx, sku);
      const row = await tx.offering.create({
        data: {
          name: input.name,
          description: emptyToNull(input.description) ?? null,
          kind: input.kind,
          sku,
          status: 'INACTIVE',
          createdById: auth.userId,
        },
      });
      await this.audit.record(tx, {
        action: 'offering.create',
        resourceType: 'offering',
        resourceId: row.id,
        after: { name: row.name, kind: row.kind, sku: row.sku, status: row.status },
      });
      return this.get(row.id, tx);
    });
  }

  async update(auth: AuthContext, id: string, input: UpdateOfferingInput): Promise<OfferingDto> {
    return this.prisma.runInTransaction(async (tx) => {
      const current = await this.lock(tx, id);
      if (current.status === 'ACTIVE' && !auth.permissions.has(Permission.OfferingsApprove)) {
        throw forbidden('Approved offerings can only be changed by an administrator who can approve offerings');
      }
      const next = {
        name: input.name,
        description: emptyToNull(input.description),
        kind: input.kind,
        sku: emptyToNull(input.sku),
      };
      const data: Prisma.OfferingUpdateInput = {};
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      for (const key of ['name', 'description', 'kind', 'sku'] as const) {
        const value = next[key];
        if (value === undefined || value === current[key]) continue;
        (data as Record<string, unknown>)[key] = value;
        before[key] = current[key];
        after[key] = value;
      }
      if (Object.keys(data).length === 0) return this.get(id, tx);
      if (typeof data.sku === 'string') await this.assertSkuFree(tx, data.sku, id);
      await tx.offering.update({ where: { id }, data });
      await this.audit.record(tx, { action: 'offering.update', resourceType: 'offering', resourceId: id, before, after });
      return this.get(id, tx);
    });
  }

  async approve(auth: AuthContext, id: string, reason?: string): Promise<OfferingDto> {
    return this.prisma.runInTransaction(async (tx) => {
      const current = await this.lock(tx, id);
      if (current.status === 'ACTIVE') throw invalidState('This offering is already approved', { status: current.status });
      const now = new Date();
      await tx.offering.update({
        where: { id },
        data: { status: 'ACTIVE', approvedById: auth.userId, approvedAt: now },
      });
      await this.audit.record(tx, {
        action: 'offering.approve',
        resourceType: 'offering',
        resourceId: id,
        before: { status: current.status },
        after: { status: 'ACTIVE', approvedById: auth.userId },
        reason: reason ?? null,
      });
      return this.get(id, tx);
    });
  }

  async deactivate(auth: AuthContext, id: string, reason: string): Promise<OfferingDto> {
    return this.prisma.runInTransaction(async (tx) => {
      const current = await this.lock(tx, id);
      if (current.status !== 'ACTIVE') throw invalidState('This offering is not active', { status: current.status });
      const live = (await this.liveCounts(tx, [id])).get(id) ?? 0;
      await tx.offering.update({ where: { id }, data: { status: 'INACTIVE' } });
      await this.audit.record(tx, {
        action: 'offering.deactivate',
        resourceType: 'offering',
        resourceId: id,
        before: { status: current.status },
        after: { status: 'INACTIVE', liveProgramCount: live },
        reason,
        actorUserId: auth.userId,
      });
      return this.get(id, tx);
    });
  }

  /** Only inactive offerings that no program or sale references can be deleted. */
  async delete(auth: AuthContext, id: string): Promise<void> {
    await this.prisma.runInTransaction(async (tx) => {
      const current = await this.lock(tx, id);
      if (current.status === 'ACTIVE') throw invalidState('Deactivate the offering before deleting it', { status: current.status });
      const programs = await tx.program.count({ where: { offeringId: id } });
      const events = await tx.qualifyingEvent.count({ where: { offeringId: id } });
      if (programs > 0 || events > 0) {
        throw invalidState('This offering is used by programs or sales and cannot be deleted', { programs, events });
      }
      await tx.offering.delete({ where: { id } });
      await this.audit.record(tx, {
        action: 'offering.delete',
        resourceType: 'offering',
        resourceId: id,
        before: Object.fromEntries(AUDITED.map((k) => [k, current[k]])),
        actorUserId: auth.userId,
      });
    });
  }

  private async lock(tx: Db, id: string) {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "offerings" WHERE "id" = ${id}::uuid FOR UPDATE`;
    if (rows.length === 0) throw notFound('Offering');
    return tx.offering.findUniqueOrThrow({ where: { id } });
  }

  private async assertSkuFree(tx: Db, sku: string, exceptId?: string): Promise<void> {
    const existing = await tx.offering.findUnique({ where: { sku }, select: { id: true } });
    if (existing && existing.id !== exceptId) {
      throw conflict('Another offering already uses this SKU', {
        issues: [{ path: 'sku', message: 'This SKU is already used by another offering', code: 'custom' }],
      });
    }
  }

  private async liveCounts(db: Db, offeringIds: string[]): Promise<Map<string, number>> {
    if (offeringIds.length === 0) return new Map();
    const groups = await db.program.groupBy({
      by: ['offeringId'],
      where: { offeringId: { in: offeringIds }, status: { in: [...LIVE_PROGRAM_STATUSES] } },
      _count: { _all: true },
    });
    return new Map(groups.map((g) => [g.offeringId, g._count._all]));
  }
}
