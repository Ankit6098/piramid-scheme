import { isIP } from 'node:net';
import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ErrorCode } from '@app/shared';
import { AppError } from '../../common/errors/app-error';
import type { Tx } from '../../common/prisma/prisma.service';
import { generateReferralCode, normalizeReferralCode } from './domain/referral-code';

/** Advisory lock guarding referral-tree writes (two-int form; see the integrity migration). */
export const REFERRAL_TREE_LOCK = { classId: 7301, objId: 1 } as const;

export interface ResolvedReferralCode {
  /** Owner of the code — becomes the new member's sponsor. */
  sponsorUserId: string;
  referralCodeId: string;
}

export interface AttachNewMemberInput {
  /** The users row inserted earlier in the same transaction `tx`. */
  userId: string;
  /** From `resolveCodeForRegistration`; null/undefined = no sponsor (root member). */
  sponsorUserId?: string | null;
  referralCodeId?: string | null;
  /** Client IP of the registration (fraud signals). Invalid values are ignored. */
  registrationIp?: string | null;
  registrationUserAgent?: string | null;
}

export interface AttachNewMemberResult {
  /** The member's newly generated global referral code. */
  referralCode: string;
}

const MAX_CODE_ATTEMPTS = 12;

/**
 * CROSS-MODULE CONTRACT: referral attribution at account creation (business rules §6).
 * Consumed by the auth slice in the transaction that verifies a registration and creates the user.
 */
@Injectable()
export class ReferralsService {
  /**
   * Validates a referral code: an active global code whose owner is ACTIVE and email-verified.
   * Normalizes input (trim, remove spaces/dashes, upper-case). Locks the code row FOR SHARE so it
   * cannot be deactivated concurrently. Safe to call outside the creating transaction too (e.g. when
   * storing a pending registration) — it is re-validated at creation time.
   *
   * @throws AppError REFERRAL_CODE_INVALID (400) without revealing which condition failed.
   */
  async resolveCodeForRegistration(tx: Tx, code: string): Promise<ResolvedReferralCode> {
    const normalized = normalizeReferralCode(code);
    if (normalized) {
      const rows = await tx.$queryRaw<Array<{ id: string; user_id: string }>>`
        SELECT rc."id", rc."user_id"
        FROM "referral_codes" rc
        JOIN "users" u ON u."id" = rc."user_id"
        WHERE rc."code" = ${normalized} AND rc."program_id" IS NULL AND rc."is_active"
          AND u."status" = 'ACTIVE' AND u."email_verified_at" IS NOT NULL
        FOR SHARE OF rc`;
      const row = rows[0];
      if (row) return { sponsorUserId: row.user_id, referralCodeId: row.id };
    }
    throw new AppError(ErrorCode.ReferralCodeInvalid, 'This referral code is not valid', 400);
  }

  /**
   * Writes the referral-tree rows for a member whose users row was inserted earlier in `tx`,
   * following the DB-enforced protocol: shared tree lock → depth-0 self row → sponsor relationship →
   * ancestor rows (sponsor's rows + 1); then generates the member's referral code.
   *
   * Must run in the same top-level transaction as the user INSERT, without savepoints (the DB checks
   * the rows were created by this transaction). Inserts only.
   */
  async attachNewMember(tx: Tx, input: AttachNewMemberInput): Promise<AttachNewMemberResult> {
    const { userId } = input;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(${REFERRAL_TREE_LOCK.classId}::int, ${REFERRAL_TREE_LOCK.objId}::int)`;
    await tx.$executeRaw`
      INSERT INTO "referral_paths" ("ancestor_id", "descendant_id", "depth")
      VALUES (${userId}::uuid, ${userId}::uuid, 0)`;

    if (input.sponsorUserId) {
      if (!input.referralCodeId) {
        throw new AppError(ErrorCode.ReferralCodeInvalid, 'This referral code is not valid', 400);
      }
      const ip = input.registrationIp && isIP(input.registrationIp) ? input.registrationIp : null;
      const userAgent = input.registrationUserAgent?.slice(0, 512) ?? null;
      await tx.$executeRaw`
        INSERT INTO "referral_relationships"
          ("id", "child_user_id", "sponsor_user_id", "referral_code_id", "source", "registration_ip", "registration_user_agent", "attributed_at", "updated_at")
        VALUES
          (${randomUUID()}::uuid, ${userId}::uuid, ${input.sponsorUserId}::uuid, ${input.referralCodeId}::uuid,
           'REGISTRATION', ${ip}::inet, ${userAgent}, now(), now())`;
      await tx.$executeRaw`
        INSERT INTO "referral_paths" ("ancestor_id", "descendant_id", "depth")
        SELECT "ancestor_id", ${userId}::uuid, "depth" + 1
        FROM "referral_paths"
        WHERE "descendant_id" = ${input.sponsorUserId}::uuid`;
    }

    return { referralCode: await this.createCodeFor(tx, userId) };
  }

  /** Inserts a unique code; collisions are skipped with ON CONFLICT so the transaction stays healthy. */
  private async createCodeFor(tx: Tx, userId: string): Promise<string> {
    for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt += 1) {
      const candidate = generateReferralCode();
      const inserted = await tx.$queryRaw<Array<{ code: string }>>`
        INSERT INTO "referral_codes" ("id", "user_id", "code", "is_active", "created_at")
        VALUES (${randomUUID()}::uuid, ${userId}::uuid, ${candidate}, true, now())
        ON CONFLICT ("code") DO NOTHING
        RETURNING "code"`;
      if (inserted[0]) return inserted[0].code;
    }
    throw new AppError(ErrorCode.Internal, 'Could not allocate a referral code; please retry', 503);
  }
}
