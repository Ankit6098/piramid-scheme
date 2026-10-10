import { Injectable } from '@nestjs/common';
import { Permission, type ProgramAdminCandidateDto, type ProgramAdminDto, type SetProgramAdminsInput } from '@app/shared';
import {
  assertProgramAccess,
  AuditService,
  forbidden,
  maskEmail,
  notFound,
  PrismaService,
  validationFailed,
  type AuthContext,
  type Db,
} from '../../common';
import { lockProgram } from './program-db';

/**
 * PROGRAM_ADMIN scoping (`program_admin_assignments`). Scopes are loaded on every request, so a
 * change applies to the admin's next request. Only `roles:assign` holders change assignments, and
 * nobody assigns themselves.
 */
@Injectable()
export class ProgramAdminsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(auth: AuthContext, programId: string): Promise<ProgramAdminDto[]> {
    assertProgramAccess(auth, programId, 'read');
    const exists = await this.prisma.program.findUnique({ where: { id: programId }, select: { id: true } });
    if (!exists) throw notFound('Program');
    const admins = await this.load(this.prisma, programId);
    // Full addresses only for those who manage assignments.
    if (auth.permissions.has(Permission.RolesAssign)) return admins;
    return admins.map((a) => ({ ...a, email: maskEmail(a.email) }));
  }

  /** Active users holding the PROGRAM_ADMIN role (assignment candidates). */
  async candidates(): Promise<ProgramAdminCandidateDto[]> {
    const users = await this.prisma.user.findMany({
      where: { status: 'ACTIVE', roles: { some: { role: { key: 'PROGRAM_ADMIN' } } } },
      select: { id: true, fullName: true, email: true },
      orderBy: [{ fullName: 'asc' }, { id: 'asc' }],
      take: 500,
    });
    return users.map((u) => ({ userId: u.id, fullName: u.fullName, email: u.email }));
  }

  async set(auth: AuthContext, programId: string, input: SetProgramAdminsInput): Promise<ProgramAdminDto[]> {
    return this.prisma.runInTransaction(async (tx) => {
      await lockProgram(tx, programId);
      const current = await tx.programAdminAssignment.findMany({ where: { programId }, select: { userId: true } });
      const currentIds = new Set(current.map((a) => a.userId));
      const nextIds = new Set(input.userIds);
      const added = input.userIds.filter((id) => !currentIds.has(id));
      const removed = [...currentIds].filter((id) => !nextIds.has(id));
      if (added.length === 0 && removed.length === 0) return this.load(tx, programId);
      if (added.includes(auth.userId)) throw forbidden('You cannot assign yourself to a program');

      if (added.length > 0) {
        const eligible = await tx.user.findMany({
          where: { id: { in: added }, status: 'ACTIVE', roles: { some: { role: { key: 'PROGRAM_ADMIN' } } } },
          select: { id: true },
        });
        const ok = new Set(eligible.map((u) => u.id));
        const invalid = input.userIds
          .map((id, index) => ({ id, index }))
          .filter((x) => added.includes(x.id) && !ok.has(x.id));
        if (invalid.length > 0) {
          throw validationFailed('Only active users with the Program Admin role can be assigned', {
            issues: invalid.map((x) => ({
              path: `userIds.${x.index}`,
              message: 'Not an active Program Admin',
              code: 'custom',
            })),
          });
        }
        await tx.programAdminAssignment.createMany({
          data: added.map((userId) => ({ userId, programId })),
          skipDuplicates: true,
        });
      }
      if (removed.length > 0) {
        await tx.programAdminAssignment.deleteMany({ where: { programId, userId: { in: removed } } });
      }
      await this.audit.record(tx, {
        action: 'program.admins_set',
        resourceType: 'program',
        resourceId: programId,
        programId,
        before: { adminUserIds: [...currentIds].sort() },
        after: { adminUserIds: [...nextIds].sort(), added, removed },
        reason: input.reason ?? null,
      });
      return this.load(tx, programId);
    });
  }

  private async load(db: Db, programId: string): Promise<ProgramAdminDto[]> {
    const rows = await db.programAdminAssignment.findMany({
      where: { programId },
      include: { user: { select: { id: true, fullName: true, email: true } } },
      orderBy: [{ createdAt: 'asc' }, { userId: 'asc' }],
    });
    return rows.map((r) => ({
      userId: r.user.id,
      fullName: r.user.fullName,
      email: r.user.email,
      assignedAt: r.createdAt.toISOString(),
    }));
  }
}
