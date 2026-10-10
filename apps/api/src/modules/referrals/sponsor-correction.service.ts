import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  ErrorCode,
  type CorrectionMemberRef,
  type SponsorCorrectionInput,
  type SponsorCorrectionIssue,
  type SponsorCorrectionPreviewResponse,
  type SponsorCorrectionResponse,
} from '@app/shared';
import { AuditService } from '../../common/audit/audit.service';
import type { AuthContext } from '../../common/auth/auth-context';
import { AppError, forbidden, invalidState, notFound } from '../../common/errors/app-error';
import { PrismaService, type Db } from '../../common/prisma/prisma.service';
import { lockReferralTreeExclusive, setReferralCorrectionId } from '../../common/prisma/referral-tree-lock';
import { evaluateSponsorCorrection, type CorrectionFacts } from './domain/correction-rules';
import { TeamRepository } from './team.repository';

interface LoadedCorrection {
  member: CorrectionMemberRef;
  newSponsor: CorrectionMemberRef;
  currentSponsor: CorrectionMemberRef | null;
  facts: CorrectionFacts;
  issues: SponsorCorrectionIssue[];
}

/**
 * Administrative sponsor corrections (business rules §6; SUPER_ADMIN, `referrals:correct`).
 *
 * The write follows the DB-enforced protocol in ONE top-level transaction without savepoints
 * (never `tx.$transaction`): exclusive tree lock FIRST → re-validate under the lock → insert the
 * `referral_corrections` row → `SET LOCAL app.referral_correction_id` → rewrite the relationship
 * (source ADMIN_CORRECTION, no referral code) → delete the closure rows linking the moved subtree to
 * its old ancestors → insert the cross product of the new upline and the subtree. The DB re-checks
 * cycles, SoD and closure consistency at commit. Past rewards never change.
 */
@Injectable()
export class SponsorCorrectionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: TeamRepository,
    private readonly audit: AuditService,
  ) {}

  /** Read-only preview: affected subtree size and every rule the correction would violate. */
  async preview(auth: AuthContext, memberId: string, newSponsorId: string): Promise<SponsorCorrectionPreviewResponse> {
    const loaded = await this.load(this.prisma, auth.userId, memberId, newSponsorId);
    const [affectedMembers, sponsorAncestors] = await Promise.all([
      this.repo.subtreeSize(this.prisma, memberId),
      this.prisma.referralPath.count({ where: { descendantId: newSponsorId, depth: { gte: 1 } } }),
    ]);
    return {
      member: loaded.member,
      currentSponsor: loaded.currentSponsor,
      newSponsor: loaded.newSponsor,
      affectedMembers,
      newDepthFromRoot: sponsorAncestors + 1,
      receivedEventCount: loaded.facts.receivedEventCount,
      issues: loaded.issues,
      canApply: loaded.issues.length === 0,
    };
  }

  async apply(auth: AuthContext, memberId: string, input: SponsorCorrectionInput): Promise<SponsorCorrectionResponse> {
    return this.prisma.runInTransaction(
      async (tx) => {
        // 1. Exclusive tree lock FIRST: serializes against registrations and other corrections.
        await lockReferralTreeExclusive(tx);

        // 2. Re-check everything under the lock.
        const loaded = await this.load(tx, auth.userId, memberId, input.newSponsorId);
        if (loaded.issues.length > 0) throw toCorrectionError(loaded.issues);
        const previousSponsorId = loaded.currentSponsor?.id ?? null;
        const affectedMembers = await this.repo.subtreeSize(tx, memberId);

        // 3. The correction row, then its id as the transaction-local authorization for the rewrite.
        const correction = await tx.referralCorrection.create({
          data: {
            childUserId: memberId,
            previousSponsorId,
            newSponsorId: input.newSponsorId,
            reason: input.reason,
            performedById: auth.userId,
          },
          select: { id: true, createdAt: true },
        });
        await setReferralCorrectionId(tx, correction.id);

        // 4. Adjacency: re-point (or create, for a former root member) the sponsor link.
        if (previousSponsorId) {
          await tx.$executeRaw`
            UPDATE "referral_relationships"
            SET "sponsor_user_id" = ${input.newSponsorId}::uuid, "referral_code_id" = NULL,
                "source" = 'ADMIN_CORRECTION', "attributed_at" = now(), "updated_at" = now()
            WHERE "child_user_id" = ${memberId}::uuid`;
        } else {
          await tx.$executeRaw`
            INSERT INTO "referral_relationships"
              ("id", "child_user_id", "sponsor_user_id", "referral_code_id", "source", "attributed_at", "updated_at")
            VALUES (${randomUUID()}::uuid, ${memberId}::uuid, ${input.newSponsorId}::uuid, NULL, 'ADMIN_CORRECTION', now(), now())`;
        }

        // 5. Detach: closure rows from the member's strict ancestors to every node of its subtree.
        await tx.$executeRaw`
          DELETE FROM "referral_paths" p
          USING "referral_paths" up, "referral_paths" sub
          WHERE up."descendant_id" = ${memberId}::uuid AND up."depth" > 0
            AND sub."ancestor_id" = ${memberId}::uuid
            AND p."ancestor_id" = up."ancestor_id"
            AND p."descendant_id" = sub."descendant_id"`;

        // 6. Attach: the new sponsor and its ancestors × the subtree.
        await tx.$executeRaw`
          INSERT INTO "referral_paths" ("ancestor_id", "descendant_id", "depth")
          SELECT up."ancestor_id", sub."descendant_id", up."depth" + sub."depth" + 1
          FROM "referral_paths" up
          JOIN "referral_paths" sub ON sub."ancestor_id" = ${memberId}::uuid
          WHERE up."descendant_id" = ${input.newSponsorId}::uuid`;

        await this.audit.record(tx, {
          action: 'referral.correct',
          resourceType: 'user',
          resourceId: memberId,
          before: { sponsorUserId: previousSponsorId },
          after: { sponsorUserId: input.newSponsorId, correctionId: correction.id, affectedMembers },
          reason: input.reason,
        });

        return {
          correctionId: correction.id,
          memberId,
          previousSponsorId,
          newSponsorId: input.newSponsorId,
          affectedMembers,
          createdAt: correction.createdAt.toISOString(),
        };
      },
      // Deferred closure-consistency triggers run per moved row at COMMIT; large subtrees take time.
      { timeout: 120_000, maxWait: 10_000 },
    );
  }

  private async load(db: Db, performerId: string, memberId: string, newSponsorId: string): Promise<LoadedCorrection> {
    // Sequential on purpose: `db` may be an interactive transaction (one connection).
    const member = await db.user.findUnique({ where: { id: memberId }, select: { id: true, fullName: true, status: true } });
    if (!member) throw notFound('Member');
    const newSponsor = await db.user.findUnique({
      where: { id: newSponsorId },
      select: { id: true, fullName: true, status: true, emailVerifiedAt: true },
    });
    if (!newSponsor) throw notFound('New sponsor');
    const rel = await db.referralRelationship.findUnique({
      where: { childUserId: memberId },
      select: { sponsor: { select: { id: true, fullName: true, status: true } } },
    });
    const cyclePath = await this.repo.depthBetween(db, memberId, newSponsorId);
    const performerPath = await this.repo.depthBetween(db, performerId, newSponsorId);
    const receivedEventCount = await this.repo.receivedEventsInSubtree(db, memberId);
    const facts: CorrectionFacts = {
      memberId,
      performerId,
      currentSponsorId: rel?.sponsor.id ?? null,
      newSponsor: { id: newSponsor.id, status: newSponsor.status, emailVerified: newSponsor.emailVerifiedAt !== null },
      newSponsorInMemberSubtree: cyclePath !== null,
      performerIsUplineOfNewSponsor: performerPath !== null,
      receivedEventCount,
    };
    return {
      member: { id: member.id, fullName: member.fullName, status: member.status },
      newSponsor: { id: newSponsor.id, fullName: newSponsor.fullName, status: newSponsor.status },
      currentSponsor: rel ? { id: rel.sponsor.id, fullName: rel.sponsor.fullName, status: rel.sponsor.status } : null,
      facts,
      issues: evaluateSponsorCorrection(facts),
    };
  }
}

/** First blocking issue → HTTP error (all issues in `details.issues`). */
export function toCorrectionError(issues: SponsorCorrectionIssue[]): AppError {
  const first = issues[0];
  const details = { issues };
  if (!first) return invalidState('The correction is not allowed', details);
  switch (first.code) {
    case 'SELF_SPONSOR':
    case 'CYCLE':
      return new AppError(ErrorCode.ReferralCycle, first.message, 409, details);
    case 'SEGREGATION_OF_DUTIES':
      return forbidden(first.message, { reason: 'SEGREGATION_OF_DUTIES', ...details });
    default:
      return invalidState(first.message, details);
  }
}

