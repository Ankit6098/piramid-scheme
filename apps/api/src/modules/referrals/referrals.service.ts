import { Injectable, NotImplementedException } from '@nestjs/common';
import type { Tx } from '../../common/prisma/prisma.service';

export interface ResolvedReferralCode {
  /** Owner of the code — becomes the new member's sponsor. */
  sponsorUserId: string;
  referralCodeId: string;
}

export interface AttachNewMemberInput {
  /** The freshly inserted user (same transaction). */
  userId: string;
  /** From `resolveCodeForRegistration`; null/undefined = no sponsor (root member). */
  sponsorUserId?: string | null;
  referralCodeId?: string | null;
}

export interface AttachNewMemberResult {
  /** The member's newly generated global referral code (8 chars, Crockford-style alphabet). */
  referralCode: string;
}

/**
 * CROSS-MODULE CONTRACT (owned by the referrals slice; consumed by the auth slice's registration flow).
 */
@Injectable()
export class ReferralsService {
  /**
   * Validates a referral code entered at registration (business rules §6).
   *
   * - Normalizes the code (trim, upper-case) and looks up an ACTIVE global code (`program_id IS NULL`).
   * - The code's owner must be ACTIVE and email-verified.
   * - Runs inside the registration transaction `tx` (read-only; may lock the code row `FOR SHARE`).
   *
   * @throws AppError `REFERRAL_CODE_INVALID` (400) when the code is unknown, inactive, or its owner is
   *         not eligible. The message must not reveal which of these applied.
   */
  async resolveCodeForRegistration(tx: Tx, code: string): Promise<ResolvedReferralCode> {
    void tx;
    void code;
    throw new NotImplementedException('referrals slice');
  }

  /**
   * Writes the referral-tree rows for a member created in the same transaction `tx`:
   * - the depth-0 self row in `referral_paths`;
   * - when a sponsor is given: the `referral_relationships` row (source REGISTRATION, referralCodeId)
   *   and one closure row per ancestor of the sponsor (`depth = sponsorDepth + 1`), i.e.
   *   `INSERT INTO referral_paths SELECT ancestor_id, :userId, depth + 1 FROM referral_paths WHERE descendant_id = :sponsor`;
   * - generates and inserts the member's unique global referral code (retry on collision).
   * Self-referral is impossible (a new user has no descendants). Inserts only — no UPDATE/DELETE,
   * so the immutability triggers are not involved.
   */
  async attachNewMember(tx: Tx, input: AttachNewMemberInput): Promise<AttachNewMemberResult> {
    void tx;
    void input;
    throw new NotImplementedException('referrals slice');
  }
}
