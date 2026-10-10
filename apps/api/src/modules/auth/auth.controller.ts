import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type { AuthContext } from '../../common/auth/auth-context';
import { SESSION_COOKIE } from '../../common/auth/cookies';
import { CurrentUser, OptionalAuth, Public } from '../../common/auth/decorators';
import { SessionTokenService, type CreatedSession } from '../../common/auth/session-token.service';
import { unauthenticated } from '../../common/errors/app-error';
import { ok } from '../../common/http/envelope';
import { RateLimit } from '../../common/throttle/throttle';
import { AuthService } from './auth.service';
import { ForgotPasswordDto, LoginDto, RegisterDto, ResendVerificationDto, ResetPasswordDto, VerifyEmailDto } from './dto';

/** The raw `sid` cookie (only used to end a previous session on login/registration/logout). */
export function sessionCookieOf(req: Request): string | null {
  const value = (req.cookies as Record<string, unknown> | undefined)?.[SESSION_COOKIE];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Sets the new session cookie and a fresh CSRF token (after login / registration). */
export function applySession(tokens: SessionTokenService, res: Response, session: CreatedSession, options: { rotateCsrf?: boolean } = {}): void {
  tokens.setSessionCookie(res, session.token, session.expiresAt);
  if (options.rotateCsrf) tokens.issueCsrfToken(res);
}

/**
 * Auth HTTP routes (/api/v1/auth): registration with email verification, login/logout, the current
 * session, password reset. Responses that could reveal whether an address has an account are
 * identical (generic 202). Admin MFA routes: MfaController (/auth/mfa).
 */
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly tokens: SessionTokenService,
  ) {}

  @Post('register')
  @Public()
  @RateLimit('auth')
  @HttpCode(202)
  async register(@Body() body: RegisterDto) {
    return ok(await this.auth.register(body));
  }

  @Post('register/resend')
  @Public()
  @RateLimit('otp')
  @HttpCode(202)
  async resend(@Body() body: ResendVerificationDto) {
    return ok(await this.auth.resendVerification(body));
  }

  @Post('verify-email')
  @Public()
  @RateLimit('otp')
  @HttpCode(200)
  async verifyEmail(@Body() body: VerifyEmailDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { response, session } = await this.auth.verifyEmail(body, sessionCookieOf(req));
    applySession(this.tokens, res, session, { rotateCsrf: true });
    return ok(response);
  }

  @Post('login')
  @Public()
  @RateLimit('auth')
  @HttpCode(200)
  async login(@Body() body: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { response, session } = await this.auth.login(body, sessionCookieOf(req));
    applySession(this.tokens, res, session, { rotateCsrf: true });
    return ok(response);
  }

  @Post('logout')
  @OptionalAuth()
  @HttpCode(200)
  async logout(
    @CurrentUser({ optional: true }) auth: AuthContext | null,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.auth.logout(auth, sessionCookieOf(req));
    this.tokens.clearSessionCookie(res);
    this.tokens.issueCsrfToken(res);
    return ok(result);
  }

  /** `{ data: { user } }`, or 401 when there is no valid session (a dead cookie is cleared). */
  @Get('session')
  @OptionalAuth()
  async session(@CurrentUser({ optional: true }) auth: AuthContext | null) {
    if (!auth) throw unauthenticated();
    return ok({ user: await this.auth.toSessionUser(auth) });
  }

  @Post('password/forgot')
  @Public()
  @RateLimit('auth')
  @HttpCode(202)
  async forgotPassword(@Body() body: ForgotPasswordDto) {
    return ok(await this.auth.forgotPassword(body));
  }

  @Post('password/reset')
  @Public()
  @RateLimit('auth')
  @HttpCode(200)
  async resetPassword(@Body() body: ResetPasswordDto) {
    return ok(await this.auth.resetPassword(body));
  }
}
