import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ErrorCode, type ReferralCodeResponse, type ValidateReferralCodeResponse } from '@app/shared';
import { AppError } from '../../common/errors/app-error';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AppConfig } from '../../config/app-config';
import { toDisplayName } from './domain/display-name';
import { generateReferralCode, normalizeReferralCode } from './domain/referral-code';
import { MAX_CODE_ATTEMPTS } from './referrals.service';

/** Member/public referral-code use cases (business rules §6). */
@Injectable()
export class ReferralCodesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
  ) {}

  /**
   * `POST /referrals/validate` (public, rate-limited): whether a code can be used at registration,
   * with the owner's privacy-filtered display name. Never reveals why a code is invalid.
   */
  async validateCode(code: string): Promise<ValidateReferralCodeResponse> {
    const normalized = normalizeReferralCode(code);
    if (!normalized) return { valid: false };
    const row = await this.prisma.referralCode.findFirst({
      where: {
        code: normalized,
        programId: null,
        isActive: true,
        user: { status: 'ACTIVE', emailVerifiedAt: { not: null } },
      },
      select: { user: { select: { fullName: true } } },
    });
    return row ? { valid: true, sponsorDisplayName: toDisplayName(row.user.fullName) } : { valid: false };
  }

  /** `GET /users/me/referral-code`: the member's active global code (created if missing) + link. */
  async getOwnCode(userId: string): Promise<ReferralCodeResponse> {
    const code = (await this.findActiveCode(userId)) ?? (await this.ensureCode(userId));
    return { code, link: this.linkFor(code) };
  }

  /** `${APP_PUBLIC_URL}/register?ref=CODE` */
  linkFor(code: string): string {
    return `${this.config.app.publicUrl}/register?ref=${encodeURIComponent(code)}`;
  }

  private async findActiveCode(userId: string): Promise<string | null> {
    const row = await this.prisma.referralCode.findFirst({
      where: { userId, programId: null, isActive: true },
      select: { code: true },
    });
    return row?.code ?? null;
  }

  /**
   * Members created through the registration protocol always have a code; this covers accounts
   * created otherwise. Idempotent under concurrency: inserts are `ON CONFLICT DO NOTHING` (code or
   * the one-active-global-code-per-member index) and the winner is read back.
   */
  private async ensureCode(userId: string): Promise<string> {
    for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt += 1) {
      await this.prisma.$executeRaw`
        INSERT INTO "referral_codes" ("id", "user_id", "code", "is_active", "created_at")
        VALUES (${randomUUID()}::uuid, ${userId}::uuid, ${generateReferralCode()}, true, now())
        ON CONFLICT DO NOTHING`;
      const code = await this.findActiveCode(userId);
      if (code) return code;
    }
    throw new AppError(ErrorCode.Internal, 'Could not allocate a referral code; please retry', 503);
  }
}
