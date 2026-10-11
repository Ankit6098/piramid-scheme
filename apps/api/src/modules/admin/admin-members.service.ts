import { Injectable } from '@nestjs/common';
import {
  ErrorCode,
  isAdminRole,
  Permission,
  type AdminMemberDetailDto,
  type AdminMemberEnrollmentDto,
  type AdminMemberListItemDto,
  type AdminMemberListQuery,
  type AdminMemberPasswordResetResultDto,
  type AdminMemberRolesResultDto,
  type AdminMemberRolesUpdateInput,
  type AdminMemberStatusResultDto,
  type ApiPage,
  type RoleKey,
  type UserStatus,
} from '@app/shared';
import { z } from 'zod';
import {
  AppError,
  assertProgramAccess,
  AuditService,
  type AuthContext,
  type Db,
  decodeCursor,
  forbidden,
  hasPermission,
  invalidState,
  mapDbError,
  maskEmail,
  notFound,
  paginate,
  PrismaService,
  programScopeFilter,
  SessionTokenService,
  type Tx,
} from '../../common';
import { Prisma } from '../../generated/prisma/client';
import { AuthService } from '../auth/auth.service';
import { SecurityNoticesService } from '../auth/security-notices.service';
import { NotificationsService } from '../notifications/notifications.service';
import { toDisplayName } from '../referrals/domain/display-name';
import {
  checkAdminPasswordReset,
  checkStatusChange,
  diffRoles,
  escapeLike,
  normalizeRoles,
  type PasswordResetRefusal,
  type StatusAction,
  type StatusChangeRefusal,
} from './domain/admin-rules';
import { loadRewardSummary, toRewardSummaryDto } from './reward-summary';

const cursorSchema = z.object({ createdAt: z.iso.datetime(), id: z.uuid() });

type Scope = 'ALL' | string[];

interface MemberListRow {
  id: string;
  fullName: string;
  email: string;
  status: UserStatus;
  emailVerifiedAt: Date | null;
  createdAt: Date;
  lastLoginAt: Date | null;
}

/** Friendly translation of the DB rule "at least one ACTIVE SUPER_ADMIN must remain". */
export function lastSuperAdminError(cause?: unknown): AppError {
  return new AppError(
    ErrorCode.InvariantViolation,
    'At least one active Super Admin must remain. Give another account the Super Admin role first.',
    409,
    { rule: 'LAST_SUPER_ADMIN' },
    cause ? { cause } : undefined,
  );
}

function isLastSuperAdminViolation(err: unknown): boolean {
  const mapped = mapDbError(err);
  if (!mapped || mapped.code !== ErrorCode.InvariantViolation) return false;
  const reason = (mapped.details as { reason?: unknown } | undefined)?.reason;
  return typeof reason === 'string' && reason.includes('SUPER_ADMIN');
}

function refusalError(reason: StatusChangeRefusal, action: StatusAction): AppError {
  switch (reason) {
    case 'SELF':
      return forbidden(action === 'suspend' ? 'You cannot suspend your own account' : 'You cannot reactivate your own account');
    case 'ADMIN_TARGET':
      return forbidden('Only a Super Admin can suspend or reactivate an administrator');
    case 'INVALID_STATUS':
      return invalidState(action === 'suspend' ? 'Only active accounts can be suspended' : 'Only suspended accounts can be reactivated');
  }
}

function passwordResetRefusalError(reason: PasswordResetRefusal): AppError {
  switch (reason) {
    case 'NOT_SUPER_ADMIN':
      return forbidden('Only a Super Admin can send a password reset');
    case 'SELF':
      return forbidden('You cannot send a password reset to your own account. Change your password from your profile instead');
    case 'INVALID_STATUS':
      return invalidState('Only active accounts can reset their password');
  }
}

/**
 * Admin member management (members:read / members:write / roles:assign). PROGRAM_ADMINs only see
 * members holding an enrollment in one of their programs (business rules §3); everything outside
 * that scope behaves as "not found". Status and role changes revoke the member's sessions, are audited
 * in the same transaction and keep at least one ACTIVE SUPER_ADMIN (checked here first, enforced by
 * the DB at commit).
 */
@Injectable()
export class AdminMembersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly sessions: SessionTokenService,
    private readonly notifications: NotificationsService,
    private readonly authService: AuthService,
    private readonly securityNotices: SecurityNoticesService,
  ) {}

  // ─── Queries ──────────────────────────────────────────────────────────────

  async list(auth: AuthContext, q: AdminMemberListQuery): Promise<ApiPage<AdminMemberListItemDto>> {
    const scope: Scope = programScopeFilter(auth, 'read');
    const empty = { data: [], page: { nextCursor: null, limit: q.limit } };
    if (scope !== 'ALL' && scope.length === 0) return empty;
    if (q.programId) assertProgramAccess(auth, q.programId, 'read');
    const cursor = decodeCursor(q.cursor, cursorSchema);

    const conditions: Prisma.Sql[] = [this.memberScopeSql(scope)];
    if (q.q) {
      // ILIKE '%…%' is served by the pg_trgm GIN indexes on users.full_name / users.email.
      const pattern = `%${escapeLike(q.q)}%`;
      conditions.push(Prisma.sql`(u."full_name" ILIKE ${pattern} OR u."email" ILIKE ${pattern})`);
    }
    if (q.status) conditions.push(Prisma.sql`u."status" = ${q.status}::"UserStatus"`);
    if (q.role) {
      conditions.push(Prisma.sql`EXISTS (SELECT 1 FROM "user_roles" ur JOIN "roles" r ON r."id" = ur."role_id"
        WHERE ur."user_id" = u."id" AND r."key" = ${q.role})`);
    }
    if (q.programId) {
      conditions.push(Prisma.sql`EXISTS (SELECT 1 FROM "program_enrollments" pe
        WHERE pe."user_id" = u."id" AND pe."program_id" = ${q.programId}::uuid)`);
    }
    if (cursor) {
      conditions.push(Prisma.sql`(u."created_at", u."id") < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`);
    }

    const rows = await this.prisma.$queryRaw<MemberListRow[]>`
      SELECT u."id", u."full_name" AS "fullName", u."email", u."status"::text AS "status",
             u."email_verified_at" AS "emailVerifiedAt", u."created_at" AS "createdAt", u."last_login_at" AS "lastLoginAt"
      FROM "users" u
      WHERE ${Prisma.join(conditions, ' AND ')}
      ORDER BY u."created_at" DESC, u."id" DESC
      LIMIT ${q.limit + 1}`;

    const ids = rows.slice(0, q.limit).map((r) => r.id);
    const canSeeFlags = scope === 'ALL';
    const [roleRows, enrollmentCounts, flagCounts] = ids.length
      ? await Promise.all([
          this.prisma.userRole.findMany({ where: { userId: { in: ids } }, select: { userId: true, role: { select: { key: true } } } }),
          this.prisma.programEnrollment.groupBy({
            by: ['userId'],
            where: { userId: { in: ids }, status: 'ACTIVE', ...(scope === 'ALL' ? {} : { programId: { in: scope } }) },
            _count: { _all: true },
          }),
          canSeeFlags
            ? this.prisma.memberFlag.groupBy({ by: ['userId'], where: { userId: { in: ids }, status: 'OPEN' }, _count: { _all: true } })
            : Promise.resolve([]),
        ])
      : [[], [], []];

    const rolesByUser = new Map<string, RoleKey[]>();
    for (const r of roleRows) {
      const list = rolesByUser.get(r.userId) ?? [];
      list.push(r.role.key as RoleKey);
      rolesByUser.set(r.userId, list);
    }
    const enrollmentsByUser = new Map(enrollmentCounts.map((r) => [r.userId, r._count._all]));
    const flagsByUser = new Map(flagCounts.map((r) => [r.userId, r._count._all]));

    return paginate(
      rows,
      q.limit,
      (r) => ({ createdAt: new Date(r.createdAt).toISOString(), id: r.id }),
      (r): AdminMemberListItemDto => ({
        id: r.id,
        fullName: r.fullName,
        email: r.email,
        status: r.status,
        emailVerified: r.emailVerifiedAt !== null,
        roles: normalizeRoles(rolesByUser.get(r.id) ?? []),
        activeEnrollments: enrollmentsByUser.get(r.id) ?? 0,
        openFlags: flagsByUser.get(r.id) ?? 0,
        createdAt: new Date(r.createdAt).toISOString(),
        lastLoginAt: r.lastLoginAt ? new Date(r.lastLoginAt).toISOString() : null,
      }),
    );
  }

  async get(auth: AuthContext, id: string): Promise<AdminMemberDetailDto> {
    const scope: Scope = programScopeFilter(auth, 'read');
    await this.assertInScope(this.prisma, scope, id);
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        fullName: true,
        email: true,
        phone: true,
        avatarUrl: true,
        status: true,
        emailVerifiedAt: true,
        createdAt: true,
        lastLoginAt: true,
        suspendedAt: true,
        suspensionReason: true,
        roles: {
          select: { createdAt: true, role: { select: { key: true } }, grantedBy: { select: { id: true, fullName: true } } },
        },
        programAssignments: { select: { program: { select: { id: true, code: true, name: true } } } },
        mfaFactors: { where: { kind: 'TOTP', confirmedAt: { not: null }, revokedAt: null }, select: { id: true }, take: 1 },
        referralCodes: { where: { programId: null, isActive: true }, select: { code: true }, take: 1 },
        sponsorRelationship: { select: { sponsor: { select: { id: true, fullName: true, email: true } } } },
      },
    });
    if (!user) throw notFound('Member');

    const programFilter = scope === 'ALL' ? {} : { programId: { in: scope } };
    const [directReferrals, totalDescendants, enrollments, rewardSummary, flags] = await Promise.all([
      this.prisma.referralRelationship.count({ where: { sponsorUserId: id } }),
      this.prisma.referralPath.count({ where: { ancestorId: id, depth: { gt: 0 } } }),
      this.prisma.programEnrollment.findMany({
        where: { userId: id, ...programFilter },
        select: {
          id: true,
          status: true,
          eligibilityStatus: true,
          effectiveFrom: true,
          effectiveTo: true,
          createdAt: true,
          optionSnapshot: true,
          option: { select: { name: true } },
          program: { select: { id: true, code: true, name: true, status: true, currencyCode: true } },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 50,
      }),
      loadRewardSummary(this.prisma, id, scope),
      scope === 'ALL'
        ? this.prisma.memberFlag.findMany({
            where: { userId: id, status: 'OPEN' },
            select: { id: true, kind: true, details: true, status: true, createdAt: true },
            orderBy: { createdAt: 'desc' },
            take: 20,
          })
        : Promise.resolve(null),
    ]);

    const roleKeys = normalizeRoles(user.roles.map((r) => r.role.key as RoleKey));
    const target = { id: user.id, roles: roleKeys, status: user.status };
    const actor = { userId: auth.userId, roles: auth.roles };
    const canWrite = hasPermission(auth, Permission.MembersWrite);
    const sponsorRow = user.sponsorRelationship?.sponsor ?? null;
    // A PROGRAM_ADMIN sees the sponsor's identity only when the sponsor is in their scope too
    // (enrolled in one of their programs); otherwise just the privacy-filtered display name.
    const sponsorInScope = sponsorRow !== null && (scope === 'ALL' || (await this.isInScope(this.prisma, scope, sponsorRow.id)));

    return {
      id: user.id,
      fullName: user.fullName,
      email: user.email,
      phone: user.phone,
      avatarUrl: user.avatarUrl,
      status: user.status,
      emailVerifiedAt: user.emailVerifiedAt?.toISOString() ?? null,
      createdAt: user.createdAt.toISOString(),
      lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
      suspendedAt: user.suspendedAt?.toISOString() ?? null,
      suspensionReason: user.suspensionReason,
      roles: user.roles
        .map((r) => ({
          role: r.role.key as RoleKey,
          grantedAt: r.createdAt.toISOString(),
          grantedBy: r.grantedBy ? { id: r.grantedBy.id, fullName: r.grantedBy.fullName } : null,
        }))
        .sort((a, b) => roleKeys.indexOf(a.role) - roleKeys.indexOf(b.role)),
      // Only programs the caller may see (a PROGRAM_ADMIN never learns about other programs here).
      programScopes: user.programAssignments
        .map((a) => a.program)
        .filter((p) => scope === 'ALL' || scope.includes(p.id))
        .sort((a, b) => a.name.localeCompare(b.name)),
      hasTotpFactor: user.mfaFactors.length > 0,
      referralCode: user.referralCodes[0]?.code ?? null,
      sponsor: sponsorRow
        ? {
            id: sponsorRow.id,
            displayName: toDisplayName(sponsorRow.fullName),
            fullName: sponsorInScope ? sponsorRow.fullName : null,
            email: sponsorInScope ? sponsorRow.email : null,
            inScope: sponsorInScope,
          }
        : null,
      team: { directReferrals, totalDescendants },
      enrollments: enrollments.map((e): AdminMemberEnrollmentDto => {
        const snapshot = (e.optionSnapshot ?? {}) as { name?: unknown; priceMinor?: unknown };
        return {
          id: e.id,
          program: { ...e.program, currencyCode: e.program.currencyCode.trim() },
          optionName: typeof snapshot.name === 'string' ? snapshot.name : e.option.name,
          priceMinor:
            typeof snapshot.priceMinor === 'string' && /^\d+$/.test(snapshot.priceMinor) ? snapshot.priceMinor : null,
          status: e.status,
          eligibilityStatus: e.eligibilityStatus,
          effectiveFrom: e.effectiveFrom?.toISOString() ?? null,
          effectiveTo: e.effectiveTo?.toISOString() ?? null,
          createdAt: e.createdAt.toISOString(),
        };
      }),
      rewardSummary: rewardSummary.map(toRewardSummaryDto),
      openFlags: flags
        ? flags.map((f) => ({ id: f.id, kind: f.kind, details: f.details, status: f.status, createdAt: f.createdAt.toISOString() }))
        : null,
      can: {
        suspend: canWrite && checkStatusChange(actor, target, 'suspend').allowed,
        reactivate: canWrite && checkStatusChange(actor, target, 'reactivate').allowed,
        changeRoles: hasPermission(auth, Permission.RolesAssign) && auth.userId !== user.id,
        sendPasswordReset:
          hasPermission(auth, Permission.MembersWrite) &&
          hasPermission(auth, Permission.RolesAssign) &&
          checkAdminPasswordReset(actor, target).allowed,
      },
    };
  }

  // ─── Commands ─────────────────────────────────────────────────────────────

  suspend(auth: AuthContext, id: string, reason: string): Promise<AdminMemberStatusResultDto> {
    return this.changeStatus(auth, id, 'suspend', reason);
  }

  reactivate(auth: AuthContext, id: string, reason: string): Promise<AdminMemberStatusResultDto> {
    return this.changeStatus(auth, id, 'reactivate', reason);
  }

  private async changeStatus(auth: AuthContext, id: string, action: StatusAction, reason: string): Promise<AdminMemberStatusResultDto> {
    if (id === auth.userId) throw refusalError('SELF', action);
    return this.withSuperAdminGuard(async (tx) => {
      await this.lockSuperAdminRole(tx);
      const target = await this.lockUser(tx, id);
      await this.assertInScope(tx, programScopeFilter(auth, 'read'), id);
      const roles = await this.rolesOf(tx, id);
      const decision = checkStatusChange({ userId: auth.userId, roles: auth.roles }, { id, roles, status: target.status }, action);
      if (!decision.allowed) throw refusalError(decision.reason, action);

      const now = new Date();
      let sessionsRevoked = 0;
      if (action === 'suspend') {
        if (roles.includes('SUPER_ADMIN')) await this.assertAnotherActiveSuperAdmin(tx, id);
        const res = await tx.user.updateMany({
          where: { id, status: 'ACTIVE' },
          data: { status: 'SUSPENDED', suspendedAt: now, suspensionReason: reason },
        });
        if (res.count !== 1) throw refusalError('INVALID_STATUS', action);
        sessionsRevoked = await this.sessions.revokeAllForUser(tx, id, 'suspended');
      } else {
        const res = await tx.user.updateMany({
          where: { id, status: 'SUSPENDED' },
          data: { status: 'ACTIVE', suspendedAt: null, suspensionReason: null },
        });
        if (res.count !== 1) throw refusalError('INVALID_STATUS', action);
      }
      const newStatus: UserStatus = action === 'suspend' ? 'SUSPENDED' : 'ACTIVE';
      const entry = await this.audit.record(tx, {
        action: action === 'suspend' ? 'member.suspend' : 'member.reactivate',
        resourceType: 'user',
        resourceId: id,
        before: { status: target.status },
        after: { status: newStatus, ...(action === 'suspend' ? { sessionsRevoked } : {}) },
        reason,
      });
      if (action === 'reactivate') {
        await this.notifications.notify(tx, {
          userId: id,
          type: 'account.reactivated',
          title: 'Your account has been reactivated',
          body: 'An administrator reactivated your account. You can sign in and use the platform again.',
          dedupeKey: `account-reactivated:${entry.id}`,
        });
      }
      return { id, status: newStatus, sessionsRevoked };
    });
  }

  async updateRoles(auth: AuthContext, id: string, input: AdminMemberRolesUpdateInput): Promise<AdminMemberRolesResultDto> {
    if (id === auth.userId) throw forbidden('You cannot change your own roles');
    return this.withSuperAdminGuard(async (tx) => {
      await this.lockSuperAdminRole(tx);
      await this.lockUser(tx, id);
      await this.assertInScope(tx, programScopeFilter(auth, 'read'), id);
      const current = await this.rolesOf(tx, id);
      const requested = normalizeRoles(input.roles);
      const { granted, revoked } = diffRoles(current, requested);
      if (!granted.length && !revoked.length) return { roles: current, granted, revoked, sessionsRevoked: 0 };

      if (revoked.includes('SUPER_ADMIN')) await this.assertAnotherActiveSuperAdmin(tx, id);
      if (granted.length) {
        const roleRows = await tx.role.findMany({ where: { key: { in: granted } }, select: { id: true } });
        if (roleRows.length !== granted.length) throw invalidState('A requested role is not configured on this platform');
        await tx.userRole.createMany({
          data: roleRows.map((r) => ({ userId: id, roleId: r.id, grantedById: auth.userId })),
        });
      }
      if (revoked.length) {
        await tx.userRole.deleteMany({ where: { userId: id, role: { key: { in: revoked } } } });
      }
      // Business rules §2: any role grant/revoke revokes all of the member's sessions.
      const sessionsRevoked = await this.sessions.revokeAllForUser(tx, id, 'roles_changed');
      const entry = await this.audit.record(tx, {
        action: 'member.roles.update',
        resourceType: 'user',
        resourceId: id,
        before: { roles: current },
        after: { roles: requested, granted, revoked, sessionsRevoked },
        reason: input.reason,
      });
      await this.notifications.notify(tx, {
        userId: id,
        type: 'account.roles_changed',
        title: 'Your account roles were updated',
        body: 'An administrator changed the roles on your account. Please sign in again to continue.',
        data: { roles: requested },
        dedupeKey: `account-roles:${entry.id}`,
      });
      return { roles: requested, granted, revoked, sessionsRevoked };
    });
  }

  /**
   * Admin-triggered password reset (business rules §2) — SUPER_ADMIN only, never yourself, ACTIVE
   * accounts. Primarily for admin-role accounts, whose self-service reset is disabled. In one
   * transaction: a PASSWORD_RESET code bound to the caller's session is emailed through the auth
   * slice (`AuthService.issueAdminPasswordReset`, code limits → 429) → all of the member's sessions
   * revoked → audit `member.password_reset.send` (reason) → every ACTIVE SUPER_ADMIN notified. The
   * password itself is unchanged until the member enters the code on the normal reset page.
   */
  async sendPasswordReset(auth: AuthContext, id: string, reason: string): Promise<AdminMemberPasswordResetResultDto> {
    const actor = { userId: auth.userId, roles: auth.roles };
    // Role and self checks first: they do not depend on the target (no existence probe).
    const early = checkAdminPasswordReset(actor, { id, status: 'ACTIVE' });
    if (!early.allowed) throw passwordResetRefusalError(early.reason);

    return this.prisma.runInTransaction(async (tx) => {
      await this.assertInScope(tx, programScopeFilter(auth, 'read'), id);
      const user = await tx.user.findUnique({
        where: { id },
        select: { id: true, email: true, fullName: true, status: true },
      });
      if (!user) throw notFound('Member');
      const decision = checkAdminPasswordReset(actor, user);
      if (!decision.allowed) throw passwordResetRefusalError(decision.reason);

      const now = new Date();
      const roles = await this.rolesOf(tx, id);
      const adminAccount = roles.some(isAdminRole);
      const issued = await this.authService.issueAdminPasswordReset(
        tx,
        { user: { id: user.id, email: user.email, fullName: user.fullName }, issuedBySessionId: auth.sessionId },
        now,
      );
      const sessionsRevoked = await this.sessions.revokeAllForUser(tx, id, 'admin_password_reset');
      const sentTo = maskEmail(user.email);
      const entry = await this.audit.record(tx, {
        action: 'member.password_reset.send',
        resourceType: 'user',
        resourceId: id,
        after: {
          challengeId: issued.challengeId,
          sentTo,
          expiresAt: issued.expiresAt,
          adminAccount,
          sessionsRevoked,
        },
        reason,
      });
      await this.securityNotices.notifySuperAdmins(tx, {
        subjectUserId: id,
        title: adminAccount ? 'Password reset sent to an admin account' : 'Password reset sent to a member account',
        paragraphs: [
          `${auth.fullName} sent a password reset code to the ${adminAccount ? 'admin ' : ''}account ${sentTo} and signed it out on every device.`,
          `Reason: ${reason}`,
          'The password changes only when the account owner enters the emailed code. If this was not expected, review the audit log.',
        ],
        dedupeKey: `admin-password-reset:${entry.id}`,
      });
      return { id, sentTo, expiresAt: issued.expiresAt.toISOString(), sessionsRevoked };
    });
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  /** Runs the transaction and turns the DB's "≥ 1 ACTIVE SUPER_ADMIN" commit failure into a friendly error. */
  private async withSuperAdminGuard<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    try {
      return await this.prisma.runInTransaction(fn);
    } catch (err) {
      if (isLastSuperAdminViolation(err)) throw lastSuperAdminError(err);
      throw err;
    }
  }

  /**
   * Serializes member status/role changes on the SUPER_ADMIN roles row — the same row the DB trigger
   * locks at commit — so two concurrent removals cannot both pass the "another super admin" check.
   * Always taken before the user row (consistent lock order).
   */
  private async lockSuperAdminRole(tx: Tx): Promise<void> {
    await tx.$queryRaw`SELECT 1 FROM "roles" WHERE "key" = 'SUPER_ADMIN' FOR UPDATE`;
  }

  private async lockUser(tx: Tx, id: string): Promise<{ id: string; status: UserStatus }> {
    const rows = await tx.$queryRaw<Array<{ id: string; status: UserStatus }>>`
      SELECT "id", "status"::text AS "status" FROM "users" WHERE "id" = ${id}::uuid FOR UPDATE`;
    const row = rows[0];
    if (!row) throw notFound('Member');
    return row;
  }

  private async rolesOf(db: Db, userId: string): Promise<RoleKey[]> {
    const rows = await db.userRole.findMany({ where: { userId }, select: { role: { select: { key: true } } } });
    return normalizeRoles(rows.map((r) => r.role.key as RoleKey));
  }

  private async assertAnotherActiveSuperAdmin(db: Db, excludingUserId: string): Promise<void> {
    const [row] = await db.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS "n"
      FROM "user_roles" ur
      JOIN "roles" r ON r."id" = ur."role_id"
      JOIN "users" u ON u."id" = ur."user_id"
      WHERE r."key" = 'SUPER_ADMIN' AND u."status" = 'ACTIVE' AND ur."user_id" <> ${excludingUserId}::uuid`;
    if (!row || row.n < 1) throw lastSuperAdminError();
  }

  /** PROGRAM_ADMIN: the member must hold an enrollment in one of the caller's programs (else 404). */
  private async assertInScope(db: Db, scope: Scope, userId: string): Promise<void> {
    if (!(await this.isInScope(db, scope, userId))) throw notFound('Member');
  }

  private async isInScope(db: Db, scope: Scope, userId: string): Promise<boolean> {
    if (scope === 'ALL') return true;
    return (
      scope.length > 0 &&
      (await db.programEnrollment.findFirst({ where: { userId, programId: { in: scope } }, select: { id: true } })) !== null
    );
  }

  private memberScopeSql(scope: Scope): Prisma.Sql {
    if (scope === 'ALL') return Prisma.sql`TRUE`;
    return Prisma.sql`EXISTS (SELECT 1 FROM "program_enrollments" e WHERE e."user_id" = u."id" AND e."program_id" = ANY(${scope}::uuid[]))`;
  }
}
