import { Injectable } from '@nestjs/common';
import {
  ErrorCode,
  Permission,
  POLICY_HARD_CAP_BPS,
  type ApiPage,
  type DeletedPolicyDto,
  type DryRunResultDto,
  type MemberProgramPolicyDto,
  type PolicyContextDto,
  type PolicyIssueDto,
  type PolicyValidationResultDto,
  type PolicyVersionDto,
  type PolicyVersionSummaryDto,
  type PublishPolicyResultDto,
  type RetirePolicyResultDto,
  type createPolicyDraftSchema,
  type dryRunPolicySchema,
  type listPoliciesQuerySchema,
  type publishPolicySchema,
  type retirePolicySchema,
  type updatePolicyDraftSchema,
  type validatePolicySchema,
} from '@app/shared';
import { z } from 'zod';
import { AuditService } from '../../common/audit/audit.service';
import type { AuthContext } from '../../common/auth/auth-context';
import { assertProgramAccess, programScopeFilter } from '../../common/auth/program-access';
import { AppError, forbidden, invalidState, notFound, staleVersion } from '../../common/errors/app-error';
import { decodeCursor, paginate } from '../../common/pagination/cursor';
import { PrismaService, type Db, type Tx } from '../../common/prisma/prisma.service';
import { PlatformSettingsService, policyDefaultsFrom } from '../../common/settings/platform-settings.service';
import type { Prisma } from '../../generated/prisma/client';
import { EnrollmentsService } from '../enrollments/enrollments.service';
import { HierarchyService } from '../referrals/hierarchy.service';
import { MAX_COMPRESSION_SEARCH_DEPTH, type CalcRule } from '../rewards/domain/reward-calculator';
import { runDryRun, syntheticAncestors, type DryRunAncestor } from './domain/dry-run';
import {
  applyChanges,
  auditDiff,
  auditSnapshot,
  displayNameOf,
  stateFromRow,
  toCalcPolicy,
  type PolicyState,
} from './domain/policy-state';
import {
  nextScheduledVersion,
  planPublication,
  planRetirement,
  versionInEffect,
  type PublicationPlan,
  type TimelineVersion,
} from './domain/policy-timeline';
import { hasErrors, PUBLISH_CLOCK_SKEW_MS, validatePolicy } from './domain/policy-validation';
import {
  policyVersionInclude,
  programContextSelect,
  toMemberPolicyDto,
  toPolicyDto,
  toPolicySummaryDto,
  type PolicyVersionRow,
  type ProgramContextRow,
} from './policy.mapper';

type CreateDraftInput = z.output<typeof createPolicyDraftSchema>;
type UpdateDraftInput = z.output<typeof updatePolicyDraftSchema>;
type ValidateInput = z.output<typeof validatePolicySchema>;
type PublishInput = z.output<typeof publishPolicySchema>;
type RetireInput = z.output<typeof retirePolicySchema>;
type DryRunInput = z.output<typeof dryRunPolicySchema>;
type ListQuery = z.output<typeof listPoliciesQuerySchema>;

/** Advisory lock namespace serializing version creation/publication per program. */
const POLICY_LOCK_CLASS = 7302;
/** Program statuses whose current policy members may read. */
const MEMBER_VISIBLE_PROGRAM_STATUSES = new Set(['SCHEDULED', 'ACTIVE', 'PAUSED', 'COMPLETED']);

const listCursorSchema = z.object({ v: z.number().int().min(1) });

const fmtUtc = (d: Date) => `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;

interface PublishCheck {
  issues: PolicyIssueDto[];
  plan: PublicationPlan | null;
}

/**
 * Reward policy versions (business rules §7): drafts, validation, effective-dated publication and
 * retirement, dry-run previews (§8) and the member transparency view. Every admin use case is
 * program-scoped (`assertProgramAccess`) and audited with the program id.
 */
@Injectable()
export class PoliciesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly settings: PlatformSettingsService,
    private readonly hierarchy: HierarchyService,
    private readonly enrollments: EnrollmentsService,
  ) {}

  // ─── reads ─────────────────────────────────────────────────────────────

  async getContext(auth: AuthContext, programId: string): Promise<PolicyContextDto> {
    assertProgramAccess(auth, programId, 'read');
    const program = await this.prisma.program.findUnique({ where: { id: programId }, select: programContextSelect });
    if (!program) throw notFound('Program');
    const [settings, versions] = await Promise.all([this.settings.get(), this.timeline(this.prisma, programId)]);
    const now = new Date();
    const defaults = policyDefaultsFrom(settings);
    return {
      program: {
        id: program.id,
        code: program.code,
        name: program.name,
        status: program.status,
        rewardUnit: program.rewardUnit,
        currencyCode: program.currencyCode,
        currencyMinorUnits: program.currencyMinorUnits,
        maxRewardDepth: program.maxRewardDepth,
        timezone: program.timezone,
      },
      defaults: { budgetBps: Math.min(defaults.budgetBps, POLICY_HARD_CAP_BPS), pointsPerCurrencyUnit: defaults.pointsPerCurrencyUnit },
      hardCapBps: POLICY_HARD_CAP_BPS,
      pointsLabel: settings.pointsLabel,
      currentVersionId: versionInEffect(versions, now)?.id ?? null,
      nextScheduledVersionId: nextScheduledVersion(versions, now)?.id ?? null,
    };
  }

  async list(auth: AuthContext, programId: string, q: ListQuery): Promise<ApiPage<PolicyVersionSummaryDto>> {
    assertProgramAccess(auth, programId, 'read');
    const exists = await this.prisma.program.count({ where: { id: programId } });
    if (!exists) throw notFound('Program');
    const cursor = decodeCursor(q.cursor, listCursorSchema);
    const rows = await this.prisma.rewardPolicyVersion.findMany({
      where: { programId, ...(q.status ? { status: q.status } : {}), ...(cursor ? { version: { lt: cursor.v } } : {}) },
      orderBy: { version: 'desc' },
      take: q.limit + 1,
      include: policyVersionInclude,
    });
    const now = new Date();
    return paginate(rows, q.limit, (r) => ({ v: r.version }), (r) => toPolicySummaryDto(r, now));
  }

  async get(auth: AuthContext, id: string): Promise<PolicyVersionDto> {
    const row = await this.loadVersion(this.prisma, id);
    assertProgramAccess(auth, row.programId, 'read');
    return this.toDto(this.prisma, row);
  }

  // ─── drafts ────────────────────────────────────────────────────────────

  async createDraft(auth: AuthContext, programId: string, input: CreateDraftInput): Promise<PolicyVersionDto> {
    assertProgramAccess(auth, programId, 'write');
    return this.prisma.runInTransaction(async (tx) => {
      const program = await tx.program.findUnique({ where: { id: programId }, select: programContextSelect });
      if (!program) throw notFound('Program');
      if (program.status === 'COMPLETED' || program.status === 'ARCHIVED') {
        throw invalidState(`Reward policies cannot be drafted for a ${program.status.toLowerCase()} program`, { status: program.status });
      }
      await this.lockProgramPolicies(tx, programId);

      const { cloneFromVersionId, ...changes } = input;
      let base: PolicyState;
      if (cloneFromVersionId) {
        const source = await tx.rewardPolicyVersion.findFirst({
          where: { id: cloneFromVersionId, programId },
          include: { rules: true },
        });
        if (!source) throw notFound('Policy version to copy');
        base = stateFromRow(source);
      } else {
        const defaults = policyDefaultsFrom(await this.settings.get(tx));
        base = {
          name: '',
          notes: null,
          triggerEventTypes: ['PRODUCT_SALE'],
          maxDepth: Math.min(3, program.maxRewardDepth),
          budgetBps: Math.min(Math.max(defaults.budgetBps, 1), POLICY_HARD_CAP_BPS),
          maxTotalPerEventMinor: null,
          minEventAmountMinor: 0n,
          pointsPerCurrencyUnit: defaults.pointsPerCurrencyUnit,
          ineligibleAncestorBehavior: 'FORFEIT',
          roundingMode: 'HALF_UP',
          requiresApproval: true,
          requireActiveEnrollment: true,
          rules: [],
        };
      }
      const max = await tx.rewardPolicyVersion.aggregate({ where: { programId }, _max: { version: true } });
      const version = (max._max.version ?? 0) + 1;
      const state = applyChanges(base, changes);
      if (changes.name === undefined) state.name = `Policy v${version}`;

      const created = await tx.rewardPolicyVersion.create({
        data: {
          programId,
          version,
          status: 'DRAFT',
          ...this.stateData(state),
          // Placeholder: the real start is chosen at publication.
          effectiveFrom: new Date(),
          effectiveTo: null,
          createdById: auth.userId,
        },
        select: { id: true },
      });
      await this.insertRules(tx, created.id, state.rules);
      await this.audit.record(tx, {
        action: 'policy.create',
        resourceType: 'reward_policy_version',
        resourceId: created.id,
        programId,
        after: { version, status: 'DRAFT', clonedFromVersionId: cloneFromVersionId ?? null, ...auditSnapshot(state) },
      });
      const row = await this.loadVersion(tx, created.id);
      return toPolicyDto(row, program, 0, new Date());
    });
  }

  async updateDraft(auth: AuthContext, id: string, input: UpdateDraftInput): Promise<PolicyVersionDto> {
    const { programId } = await this.programOf(id);
    assertProgramAccess(auth, programId, 'write');
    const { expectedUpdatedAt, ...changes } = input;
    return this.prisma.runInTransaction(async (tx) => {
      const locked = await this.lockVersionRow(tx, id);
      if (locked.status !== 'DRAFT') {
        throw invalidState('Published versions are immutable. Copy this version into a new draft to make changes', {
          status: locked.status,
        });
      }
      if (expectedUpdatedAt !== undefined && new Date(expectedUpdatedAt).getTime() !== locked.updatedAt.getTime()) {
        throw staleVersion('This draft was changed by someone else. Reload it and try again');
      }
      const current = await this.loadVersion(tx, id);
      const before = stateFromRow(current);
      const after = applyChanges(before, changes);
      const diff = auditDiff(before, after);
      if (Object.keys(diff.after).length === 0) return this.toDto(tx, current);

      await tx.rewardPolicyVersion.update({ where: { id }, data: { ...this.stateData(after), updatedAt: new Date() } });
      if (changes.rules !== undefined) {
        await tx.rewardRule.deleteMany({ where: { policyVersionId: id } });
        await this.insertRules(tx, id, after.rules);
      }
      await this.audit.record(tx, {
        action: 'policy.update',
        resourceType: 'reward_policy_version',
        resourceId: id,
        programId,
        before: diff.before,
        after: diff.after,
      });
      return this.toDto(tx, await this.loadVersion(tx, id));
    });
  }

  async deleteDraft(auth: AuthContext, id: string): Promise<DeletedPolicyDto> {
    const { programId } = await this.programOf(id);
    assertProgramAccess(auth, programId, 'write');
    return this.prisma.runInTransaction(async (tx) => {
      const locked = await this.lockVersionRow(tx, id);
      if (locked.status !== 'DRAFT') {
        throw invalidState('Only draft versions can be deleted; retire a published version instead', { status: locked.status });
      }
      const row = await tx.rewardPolicyVersion.delete({ where: { id }, select: { version: true, name: true } });
      await this.audit.record(tx, {
        action: 'policy.delete',
        resourceType: 'reward_policy_version',
        resourceId: id,
        programId,
        before: { version: row.version, name: row.name, status: 'DRAFT' },
      });
      return { id, deleted: true as const };
    });
  }

  // ─── validation & lifecycle ───────────────────────────────────────────

  async validate(auth: AuthContext, id: string, input: ValidateInput): Promise<PolicyValidationResultDto> {
    const row = await this.loadVersion(this.prisma, id);
    assertProgramAccess(auth, row.programId, 'write');
    if (input.changes && row.status !== 'DRAFT') {
      throw invalidState('Published versions are immutable', { status: row.status });
    }
    const program = await this.loadProgram(this.prisma, row.programId);
    const state = applyChanges(stateFromRow(row), input.changes);
    const at =
      row.status === 'DRAFT' && input.effectiveFrom !== undefined ? this.normalizeStart(new Date(input.effectiveFrom), new Date()) : null;
    const { issues } = await this.check(this.prisma, auth, row, state, program, at);
    return { valid: !hasErrors(issues), issues };
  }

  async publish(auth: AuthContext, id: string, input: PublishInput): Promise<PublishPolicyResultDto> {
    const { programId } = await this.programOf(id);
    assertProgramAccess(auth, programId, 'write');
    return this.prisma.runInTransaction(
      async (tx) => {
        await this.lockProgramPolicies(tx, programId);
        // Lock every version of the program (event binding takes FOR SHARE on the policy row, so no
        // sale can be priced by a version while its range is being closed).
        await tx.$queryRaw`SELECT "id" FROM "reward_policy_versions" WHERE "program_id" = ${programId}::uuid ORDER BY "id" FOR UPDATE`;
        const draft = await this.loadVersion(tx, id);
        if (draft.status !== 'DRAFT') {
          throw invalidState('Only draft versions can be published', { status: draft.status });
        }
        if (!draft.requiresApproval && !auth.permissions.has(Permission.PoliciesAutoApprove)) {
          throw forbidden('Only a Super Admin can publish a policy whose rewards skip manual approval', {
            missingPermissions: [Permission.PoliciesAutoApprove],
          });
        }
        const program = await this.loadProgram(tx, programId);
        const now = new Date();
        const at = this.normalizeStart(new Date(input.effectiveFrom), now);
        const state = stateFromRow(draft);
        const { issues, plan } = await this.check(tx, auth, draft, state, program, at);
        if (hasErrors(issues) || !plan || !plan.ok) {
          throw new AppError(ErrorCode.PolicyInvalid, 'This policy cannot be published yet. Fix the listed problems first', 400, {
            issues,
          });
        }

        if (plan.close) {
          await tx.rewardPolicyVersion.update({ where: { id: plan.close.id }, data: { effectiveTo: at } });
          await this.audit.record(tx, {
            action: 'policy.close',
            resourceType: 'reward_policy_version',
            resourceId: plan.close.id,
            programId,
            before: { effectiveTo: plan.close.previousEffectiveTo },
            after: { effectiveTo: at, supersededByVersionId: id },
          });
        }
        await tx.rewardPolicyVersion.update({
          where: { id },
          data: { status: 'PUBLISHED', effectiveFrom: at, effectiveTo: plan.effectiveTo, publishedAt: now, publishedById: auth.userId },
        });
        await this.audit.record(tx, {
          action: 'policy.publish',
          resourceType: 'reward_policy_version',
          resourceId: id,
          programId,
          before: { status: 'DRAFT' },
          after: {
            status: 'PUBLISHED',
            version: draft.version,
            effectiveFrom: at,
            effectiveTo: plan.effectiveTo,
            requiresApproval: draft.requiresApproval,
            budgetBps: draft.budgetBps,
            closedVersionId: plan.close?.id ?? null,
          },
        });
        const published = await this.loadVersion(tx, id);
        return {
          policy: await this.toDto(tx, published),
          closedVersion: plan.close ? { id: plan.close.id, version: plan.close.version, effectiveTo: at.toISOString() } : null,
        };
      },
      { timeout: 20_000 },
    );
  }

  async retire(auth: AuthContext, id: string, input: RetireInput): Promise<RetirePolicyResultDto> {
    const { programId } = await this.programOf(id);
    assertProgramAccess(auth, programId, 'write');
    return this.prisma.runInTransaction(async (tx) => {
      await this.lockProgramPolicies(tx, programId);
      await this.lockVersionRow(tx, id);
      const v = await this.loadVersion(tx, id);
      if (v.status === 'DRAFT') throw invalidState('Drafts are deleted, not retired', { status: v.status });
      if (v.status === 'RETIRED') throw invalidState('This version is already retired', { status: v.status });

      const now = new Date();
      const plan = planRetirement(v, now);
      if (!plan.alreadyEnded) {
        const late = await tx.qualifyingEvent.count({ where: { policyVersionId: id, occurredAt: { gte: plan.effectiveTo } } });
        if (late > 0) {
          throw invalidState('Sales after this moment are already priced by this version, so it cannot end yet. Try again in a few minutes', {
            boundSales: late,
          });
        }
      }
      await tx.rewardPolicyVersion.update({
        where: { id },
        data: { status: 'RETIRED', retiredAt: now, effectiveTo: plan.effectiveTo },
      });

      const warnings: string[] = [];
      const versions = await this.timeline(tx, programId);
      if (plan.withdrawn) {
        // The version that was closed when this one was scheduled keeps its end (ranges never grow back).
        const predecessor = versions.find((o) => o.id !== id && o.effectiveTo?.getTime() === v.effectiveFrom.getTime());
        if (predecessor) {
          warnings.push(
            `Version v${predecessor.version} still ends at ${fmtUtc(v.effectiveFrom)}. No policy will apply after that until another version is published.`,
          );
        }
      } else if (!plan.alreadyEnded) {
        const next = nextScheduledVersion(versions, now);
        warnings.push(
          next
            ? `No policy applies until version v${next.version} takes effect at ${fmtUtc(next.effectiveFrom)}; sales in between will be rejected.`
            : 'No reward policy is in effect now. New sales will be rejected until another version is published.',
        );
      }
      await this.audit.record(tx, {
        action: 'policy.retire',
        resourceType: 'reward_policy_version',
        resourceId: id,
        programId,
        reason: input.reason,
        before: { status: 'PUBLISHED', effectiveTo: v.effectiveTo },
        after: { status: 'RETIRED', effectiveTo: plan.effectiveTo, withdrawn: plan.withdrawn },
      });
      return { policy: await this.toDto(tx, await this.loadVersion(tx, id)), withdrawn: plan.withdrawn, warnings };
    });
  }

  // ─── dry-run ───────────────────────────────────────────────────────────

  async dryRun(auth: AuthContext, id: string, input: DryRunInput): Promise<DryRunResultDto> {
    const row = await this.loadVersion(this.prisma, id);
    assertProgramAccess(auth, row.programId, 'write');
    if (input.changes && row.status !== 'DRAFT') {
      throw invalidState('Published versions are immutable', { status: row.status });
    }
    const program = await this.loadProgram(this.prisma, row.programId);
    const state = applyChanges(stateFromRow(row), input.changes);
    const unit = {
      rewardUnit: program.rewardUnit,
      currencyCode: program.currencyCode,
      currencyMinorUnits: program.currencyMinorUnits,
      pointsPerCurrencyUnit: state.pointsPerCurrencyUnit,
    };
    const base = {
      policyVersionId: row.id,
      eventType: input.eventType,
      saleAmountMinor: BigInt(input.saleAmountMinor),
      policy: toCalcPolicy(state, { id: row.id, version: row.version }),
      unit,
    };
    if (input.subjectUserId !== undefined) {
      await this.assertDryRunSubjectReadable(auth, program.id, input.subjectUserId);
      const occurredAt = input.occurredAt ? new Date(input.occurredAt) : new Date();
      const ancestors = await this.ancestorsAtSale(this.prisma, program.id, input.subjectUserId, occurredAt, state);
      return runDryRun({ ...base, mode: 'MEMBER', occurredAt, ancestors });
    }
    return runDryRun({ ...base, mode: 'SYNTHETIC', occurredAt: null, ancestors: syntheticAncestors(input.ancestors ?? []) });
  }

  // ─── member transparency ──────────────────────────────────────────────

  async memberPolicy(programId: string): Promise<MemberProgramPolicyDto | null> {
    const program = await this.prisma.program.findUnique({ where: { id: programId }, select: programContextSelect });
    if (!program || !MEMBER_VISIBLE_PROGRAM_STATUSES.has(program.status)) throw notFound('Program');
    const rows = await this.prisma.rewardPolicyVersion.findMany({
      where: { programId, status: { in: ['PUBLISHED', 'RETIRED'] } },
      include: policyVersionInclude,
    });
    const now = new Date();
    const current = versionInEffect(rows, now);
    if (current) return toMemberPolicyDto(current, program, true);
    const next = nextScheduledVersion(rows, now);
    return next ? toMemberPolicyDto(next, program, false) : null;
  }

  // ─── internals ─────────────────────────────────────────────────────────

  /**
   * A real-tree dry-run reveals the subject's upline (display names, eligibility). A program-scoped
   * caller (PROGRAM_ADMIN) may only use a subject enrolled in THIS program — the members API rule,
   * narrowed to the policy's program; anyone else behaves as "not found" (no existence probe).
   */
  private async assertDryRunSubjectReadable(auth: AuthContext, programId: string, subjectUserId: string): Promise<void> {
    if (programScopeFilter(auth, 'read') === 'ALL') return;
    const enrolled = await this.prisma.programEnrollment.findFirst({
      where: { userId: subjectUserId, programId },
      select: { id: true },
    });
    if (!enrolled) throw notFound('Member');
  }

  /**
   * Eligibility of the subject's upline at the sale instant — the same rules as the reward engine
   * (account ACTIVE + verified; with requireActiveEnrollment an ELIGIBLE enrollment covering it).
   */
  private async ancestorsAtSale(db: Db, programId: string, subjectUserId: string, occurredAt: Date, state: PolicyState): Promise<DryRunAncestor[]> {
    const subject = await db.user.findUnique({ where: { id: subjectUserId }, select: { id: true } });
    if (!subject) throw notFound('Member');
    const searchDepth = state.ineligibleAncestorBehavior === 'COMPRESS' ? MAX_COMPRESSION_SEARCH_DEPTH : state.maxDepth;
    const refs = await this.hierarchy.getAncestors(db, subjectUserId, searchDepth);
    const ids = refs.map((r) => r.userId);
    const users = await db.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, status: true, emailVerifiedAt: true, fullName: true },
    });
    const byId = new Map(users.map((u) => [u.id, u]));
    const eligible = state.requireActiveEnrollment ? await this.enrollments.findEligibleEnrollments(db, programId, ids, occurredAt) : null;
    return refs.map((r) => {
      const u = byId.get(r.userId);
      let reason: string | undefined;
      if (!u || u.status !== 'ACTIVE') reason = 'account not active';
      else if (!u.emailVerifiedAt) reason = 'email not verified';
      else if (eligible && !eligible.has(r.userId)) reason = 'no eligible enrollment at the sale date';
      return {
        userId: r.userId,
        depth: r.depth,
        eligible: reason === undefined,
        displayName: u ? displayNameOf(u.fullName) : null,
        ...(reason ? { ineligibleReason: reason } : {}),
      };
    });
  }

  /** Domain validation + (for a publication start) timeline checks against the program's versions. */
  private async check(
    db: Db,
    auth: AuthContext,
    row: PolicyVersionRow,
    state: PolicyState,
    program: ProgramContextRow & { endsAt: Date | null },
    at: Date | null,
  ): Promise<PublishCheck> {
    const now = new Date();
    const issues: PolicyIssueDto[] = validatePolicy(
      { ...state, effectiveFrom: at ?? now, effectiveTo: null },
      {
        programMaxDepth: program.maxRewardDepth,
        programStatus: program.status,
        now,
        forPublish: at !== null,
        unit: { rewardUnit: program.rewardUnit, currencyCode: program.currencyCode, currencyMinorUnits: program.currencyMinorUnits },
        canAutoApprove: auth.permissions.has(Permission.PoliciesAutoApprove),
      },
    );
    if (at === null) return { issues, plan: null };

    const versions = (await this.timeline(db, row.programId)).filter((v) => v.id !== row.id);
    const plan = planPublication(versions, at);
    if (!plan.ok) {
      issues.push({
        severity: 'error',
        path: 'effectiveFrom',
        code: plan.code,
        message:
          plan.code === 'START_COLLISION'
            ? `Version v${plan.conflictingVersion} already starts at this time. Choose another start or retire that version first`
            : `Retired version v${plan.conflictingVersion} covers this time. Choose a later start`,
      });
      return { issues, plan };
    }
    if (plan.close) {
      const bound = await db.qualifyingEvent.count({ where: { policyVersionId: plan.close.id, occurredAt: { gte: at } } });
      if (bound > 0) {
        issues.push({
          severity: 'error',
          path: 'effectiveFrom',
          code: 'BOUND_SALES_AFTER_START',
          message: `${bound} sale(s) after this time are already priced by version v${plan.close.version}. Choose a later start`,
        });
      } else {
        issues.push({
          severity: 'warning',
          path: 'effectiveFrom',
          code: 'CLOSES_CURRENT',
          message: `Version v${plan.close.version} will stop applying at ${fmtUtc(at)}`,
        });
      }
    }
    if (plan.next) {
      issues.push({
        severity: 'warning',
        path: 'effectiveFrom',
        code: 'ENDS_AT_NEXT',
        message: `Version v${plan.next.version} is scheduled for ${fmtUtc(plan.next.effectiveFrom)}; this version will apply until then`,
      });
    }
    if (program.endsAt && at.getTime() >= program.endsAt.getTime()) {
      issues.push({
        severity: 'warning',
        path: 'effectiveFrom',
        code: 'STARTS_AFTER_PROGRAM_END',
        message: 'This start is after the program ends; no sales will qualify under it',
      });
    }
    return { issues, plan };
  }

  /** A start a few seconds in the past ("now" from the browser) is moved to now; older ones stay (and fail validation). */
  private normalizeStart(requested: Date, now: Date): Date {
    if (requested.getTime() < now.getTime() && requested.getTime() >= now.getTime() - PUBLISH_CLOCK_SKEW_MS) return now;
    return requested;
  }

  private async timeline(db: Db, programId: string): Promise<TimelineVersion[]> {
    return db.rewardPolicyVersion.findMany({
      where: { programId, status: { in: ['PUBLISHED', 'RETIRED'] } },
      select: { id: true, version: true, status: true, effectiveFrom: true, effectiveTo: true },
      orderBy: { effectiveFrom: 'asc' },
    });
  }

  private async programOf(id: string): Promise<{ programId: string }> {
    const row = await this.prisma.rewardPolicyVersion.findUnique({ where: { id }, select: { programId: true } });
    if (!row) throw notFound('Policy version');
    return row;
  }

  private async loadVersion(db: Db, id: string): Promise<PolicyVersionRow> {
    const row = await db.rewardPolicyVersion.findUnique({ where: { id }, include: policyVersionInclude });
    if (!row) throw notFound('Policy version');
    return row;
  }

  private async loadProgram(db: Db, programId: string): Promise<ProgramContextRow & { endsAt: Date | null }> {
    const program = await db.program.findUnique({ where: { id: programId }, select: { ...programContextSelect, endsAt: true } });
    if (!program) throw notFound('Program');
    return program;
  }

  /** Sequential on purpose: `db` may be an interactive transaction (one connection). */
  private async toDto(db: Db, row: PolicyVersionRow): Promise<PolicyVersionDto> {
    const program = await this.loadProgram(db, row.programId);
    const bound = row.status === 'DRAFT' ? 0 : await db.qualifyingEvent.count({ where: { policyVersionId: row.id } });
    return toPolicyDto(row, program, bound, new Date());
  }

  private async lockProgramPolicies(tx: Tx, programId: string): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${POLICY_LOCK_CLASS}::int, hashtext(${programId}))`;
  }

  private async lockVersionRow(tx: Tx, id: string): Promise<{ status: string; updatedAt: Date }> {
    const rows = await tx.$queryRaw<Array<{ status: string; updated_at: Date }>>`
      SELECT "status"::text AS "status", "updated_at" FROM "reward_policy_versions" WHERE "id" = ${id}::uuid FOR UPDATE`;
    const row = rows[0];
    if (!row) throw notFound('Policy version');
    return { status: row.status, updatedAt: row.updated_at };
  }

  private stateData(state: PolicyState) {
    return {
      name: state.name,
      notes: state.notes,
      triggerEventTypes: state.triggerEventTypes,
      maxDepth: state.maxDepth,
      budgetBps: state.budgetBps,
      maxTotalPerEventMinor: state.maxTotalPerEventMinor,
      minEventAmountMinor: state.minEventAmountMinor,
      pointsPerCurrencyUnit: state.pointsPerCurrencyUnit,
      ineligibleAncestorBehavior: state.ineligibleAncestorBehavior,
      roundingMode: state.roundingMode,
      requiresApproval: state.requiresApproval,
      requireActiveEnrollment: state.requireActiveEnrollment,
    } satisfies Prisma.RewardPolicyVersionUncheckedUpdateInput;
  }

  private async insertRules(tx: Tx, policyVersionId: string, rules: readonly CalcRule[]): Promise<void> {
    if (rules.length === 0) return;
    await tx.rewardRule.createMany({
      data: rules.map((r) => ({
        policyVersionId,
        level: r.level,
        calcType: r.calcType,
        fixedAmountMinor: r.calcType === 'FIXED' ? r.fixedAmountMinor : null,
        percentageBps: r.calcType === 'PERCENTAGE' ? r.percentageBps : null,
        capMinor: r.capMinor,
      })),
    });
  }
}
