import { Body, Controller, HttpCode, Post, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import type { AuthContext } from '../../common/auth/auth-context';
import { CurrentUser } from '../../common/auth/decorators';
import { SessionTokenService } from '../../common/auth/session-token.service';
import { ok } from '../../common/http/envelope';
import { RateLimit } from '../../common/throttle/throttle';
import { applySession } from './auth.controller';
import { MfaCodeDto } from './dto';
import { MfaService } from './mfa.service';

/**
 * Admin second factor (/api/v1/auth/mfa). Requires a signed-in admin session; every successful step
 * rotates the session cookie. Not under /admin, so sessions without admin access can reach it.
 */
@ApiTags('auth')
@Controller('auth/mfa')
export class MfaController {
  constructor(
    private readonly mfa: MfaService,
    private readonly tokens: SessionTokenService,
  ) {}

  /** Emails a LOGIN_MFA code bound to this session (admins without an authenticator yet). */
  @Post('email/send')
  @RateLimit('otp')
  @HttpCode(200)
  async sendEmailCode(@CurrentUser() auth: AuthContext) {
    return ok(await this.mfa.sendEmailCode(auth));
  }

  @Post('email/verify')
  @RateLimit('otp')
  @HttpCode(200)
  async verifyEmailCode(@CurrentUser() auth: AuthContext, @Body() body: MfaCodeDto, @Res({ passthrough: true }) res: Response) {
    const { response, session } = await this.mfa.verifyEmailCode(auth, body.code);
    applySession(this.tokens, res, session);
    return ok(response);
  }

  /** Returns the otpauth URI + secret ONCE; the secret is stored encrypted until confirmed. */
  @Post('totp/setup')
  @RateLimit('otp')
  @HttpCode(200)
  async setupTotp(@CurrentUser() auth: AuthContext) {
    return ok(await this.mfa.setupTotp(auth));
  }

  @Post('totp/confirm')
  @RateLimit('otp')
  @HttpCode(200)
  async confirmTotp(@CurrentUser() auth: AuthContext, @Body() body: MfaCodeDto, @Res({ passthrough: true }) res: Response) {
    const { response, session } = await this.mfa.confirmTotp(auth, body.code);
    applySession(this.tokens, res, session);
    return ok(response);
  }

  @Post('totp/verify')
  @RateLimit('otp')
  @HttpCode(200)
  async verifyTotp(@CurrentUser() auth: AuthContext, @Body() body: MfaCodeDto, @Res({ passthrough: true }) res: Response) {
    const { response, session } = await this.mfa.verifyTotpCode(auth, body.code);
    applySession(this.tokens, res, session);
    return ok(response);
  }
}
