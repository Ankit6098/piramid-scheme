import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { ApiResponse, ValidateReferralCodeResponse } from '@app/shared';
import { Public } from '../../common/auth/decorators';
import { ok } from '../../common/http/envelope';
import { RateLimit } from '../../common/throttle/throttle';
import { ValidateReferralCodeDto } from './dto';
import { ReferralCodesService } from './referral-codes.service';

/** Public referral routes (/api/v1/referrals). */
@ApiTags('referrals')
@Controller('referrals')
export class ReferralsController {
  constructor(private readonly codes: ReferralCodesService) {}

  /**
   * Registration-form check of a referral code. Always 200 (`valid: false` never says why).
   * Strictly rate-limited per IP: it reveals the owner's display name.
   */
  @Post('validate')
  @Public()
  @HttpCode(200)
  @RateLimit('auth', { limit: 20, ttl: 60_000 })
  async validate(@Body() body: ValidateReferralCodeDto): Promise<ApiResponse<ValidateReferralCodeResponse>> {
    return ok(await this.codes.validateCode(body.code));
  }
}
