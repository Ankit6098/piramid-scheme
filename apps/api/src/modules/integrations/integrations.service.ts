import { Injectable } from '@nestjs/common';
import type {
  ApiClientDto,
  CreatedApiClientDto,
  createApiClientSchema,
  listApiClientsQuerySchema,
  revokeApiClientSchema,
} from '@app/shared';
import type { ApiPage } from '@app/shared';
import { z } from 'zod';
import { AuditService } from '../../common/audit/audit.service';
import type { AuthContext } from '../../common/auth/auth-context';
import { assertProgramAccess, programScopeFilter } from '../../common/auth/program-access';
import { invalidState, notFound } from '../../common/errors/app-error';
import { decodeCursor, paginate } from '../../common/pagination/cursor';
import { keysetWhere } from '../../common/pagination/keyset';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import { generateApiKey, hashApiKey } from './domain/api-key';

type CreateInput = z.output<typeof createApiClientSchema>;
type ListQuery = z.output<typeof listApiClientsQuerySchema>;
type RevokeInput = z.output<typeof revokeApiClientSchema>;

/** The machine principal of an integration request. */
export interface ApiClientPrincipal {
  id: string;
  programId: string;
}

const clientInclude = {
  program: { select: { id: true, code: true, name: true } },
  createdBy: { select: { id: true, fullName: true } },
} satisfies Prisma.ApiClientInclude;
type ClientRow = Prisma.ApiClientGetPayload<{ include: typeof clientInclude }>;

const listCursorSchema = z.object({ c: z.iso.datetime(), id: z.uuid() });
/** Longest bearer token we bother hashing. */
const MAX_KEY_LENGTH = 256;

function toDto(row: ClientRow): ApiClientDto {
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.keyPrefix,
    status: row.revokedAt ? 'REVOKED' : 'ACTIVE',
    program: { id: row.program.id, code: row.program.code, name: row.program.name },
    createdBy: row.createdBy ? { id: row.createdBy.id, fullName: row.createdBy.fullName } : null,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}

/**
 * API clients (business rules §8): one program per key, key shown once and stored as SHA-256,
 * revocation is immediate (checked on every request and by the event insert trigger).
 */
@Injectable()
export class IntegrationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(auth: AuthContext, input: CreateInput): Promise<CreatedApiClientDto> {
    assertProgramAccess(auth, input.programId, 'write');
    return this.prisma.runInTransaction(async (tx) => {
      const program = await tx.program.findUnique({ where: { id: input.programId }, select: { status: true } });
      if (!program) throw notFound('Program');
      if (program.status === 'ARCHIVED') throw invalidState('API clients cannot be created for an archived program', { status: program.status });
      const key = generateApiKey();
      const row = await tx.apiClient.create({
        data: { name: input.name, programId: input.programId, keyPrefix: key.keyPrefix, keyHash: key.keyHash, createdById: auth.userId },
        include: clientInclude,
      });
      await this.audit.record(tx, {
        action: 'api_client.create',
        resourceType: 'api_client',
        resourceId: row.id,
        programId: input.programId,
        after: { name: row.name, keyPrefix: row.keyPrefix },
      });
      return { client: toDto(row), apiKey: key.apiKey };
    });
  }

  async list(auth: AuthContext, q: ListQuery): Promise<ApiPage<ApiClientDto>> {
    const scope = programScopeFilter(auth, 'write');
    if (q.programId) assertProgramAccess(auth, q.programId, 'write');
    const cursor = decodeCursor(q.cursor, listCursorSchema);
    const and: Prisma.ApiClientWhereInput[] = [];
    if (scope !== 'ALL') and.push({ programId: { in: scope } });
    if (q.programId) and.push({ programId: q.programId });
    if (q.status === 'ACTIVE') and.push({ revokedAt: null });
    if (q.status === 'REVOKED') and.push({ revokedAt: { not: null } });
    if (cursor) {
      const c = new Date(cursor.c);
      and.push(keysetWhere<Prisma.ApiClientWhereInput>('createdAt', c, cursor.id, 'desc'));
    }
    const rows = await this.prisma.apiClient.findMany({
      where: { AND: and },
      include: clientInclude,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
    });
    return paginate(rows, q.limit, (r) => ({ c: r.createdAt.toISOString(), id: r.id }), toDto);
  }

  async revoke(auth: AuthContext, id: string, input: RevokeInput): Promise<ApiClientDto> {
    const existing = await this.prisma.apiClient.findUnique({ where: { id }, select: { programId: true } });
    if (!existing) throw notFound('API client');
    assertProgramAccess(auth, existing.programId, 'write');
    return this.prisma.runInTransaction(async (tx) => {
      const now = new Date();
      const res = await tx.apiClient.updateMany({ where: { id, revokedAt: null }, data: { revokedAt: now } });
      if (res.count !== 1) throw invalidState('This API client is already revoked');
      const row = await tx.apiClient.findUniqueOrThrow({ where: { id }, include: clientInclude });
      await this.audit.record(tx, {
        action: 'api_client.revoke',
        resourceType: 'api_client',
        resourceId: id,
        programId: existing.programId,
        reason: input.reason ? input.reason : null,
        before: { revokedAt: null },
        after: { revokedAt: now },
      });
      return toDto(row);
    });
  }

  /** Resolves a bearer key to its active client (null for unknown or revoked keys). */
  async authenticate(apiKey: string | null): Promise<ApiClientPrincipal | null> {
    if (!apiKey || apiKey.length > MAX_KEY_LENGTH) return null;
    const row = await this.prisma.apiClient.findUnique({
      where: { keyHash: hashApiKey(apiKey) },
      select: { id: true, programId: true, revokedAt: true },
    });
    if (!row || row.revokedAt) return null;
    return { id: row.id, programId: row.programId };
  }

  /** Records that the key was used (best effort, never fails the request). */
  async touch(clientId: string): Promise<void> {
    await this.prisma.apiClient.updateMany({ where: { id: clientId, revokedAt: null }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
  }
}
