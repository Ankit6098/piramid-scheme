import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import type { AuthContext } from '../../common/auth/auth-context';
import { CurrentUser } from '../../common/auth/decorators';
import { SessionTokenService } from '../../common/auth/session-token.service';
import { ok } from '../../common/http/envelope';
import { RateLimit } from '../../common/throttle/throttle';
import { IdParamDto } from '../../common/validation/zod';
import { ChangePasswordDto, ConfirmEmailChangeDto, PageQueryDto, ResetTotpDto, StartEmailChangeDto, UpdateProfileDto } from './dto';
import { UsersService } from './users.service';

/**
 * Self-service account routes (/api/v1/users/me/*) for any signed-in user. HTTP only — every use case
 * is scoped to the caller's own account in UsersService.
 */
@ApiTags('users')
@Controller('users/me')
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly tokens: SessionTokenService,
  ) {}

  @Get()
  async me(@CurrentUser() auth: AuthContext) {
    return ok(await this.users.getProfile(auth));
  }

  @Patch()
  async update(@CurrentUser() auth: AuthContext, @Body() body: UpdateProfileDto) {
    return ok(await this.users.updateProfile(auth, body));
  }

  @Post('password')
  @RateLimit('auth')
  @HttpCode(200)
  async changePassword(@CurrentUser() auth: AuthContext, @Body() body: ChangePasswordDto) {
    return ok(await this.users.changePassword(auth, body));
  }

  @Post('email-change')
  @RateLimit('otp')
  @HttpCode(202)
  async startEmailChange(@CurrentUser() auth: AuthContext, @Body() body: StartEmailChangeDto) {
    return ok(await this.users.startEmailChange(auth, body));
  }

  @Post('email-change/confirm')
  @RateLimit('otp')
  @HttpCode(200)
  async confirmEmailChange(@CurrentUser() auth: AuthContext, @Body() body: ConfirmEmailChangeDto) {
    return ok(await this.users.confirmEmailChange(auth, body));
  }

  @Get('sessions')
  async sessions(@CurrentUser() auth: AuthContext, @Query() query: PageQueryDto) {
    return this.users.listSessions(auth, query);
  }

  @Post('sessions/revoke-others')
  @HttpCode(200)
  async revokeOthers(@CurrentUser() auth: AuthContext) {
    return ok(await this.users.revokeOtherSessions(auth));
  }

  @Delete('sessions/:id')
  async revokeSession(@CurrentUser() auth: AuthContext, @Param() params: IdParamDto, @Res({ passthrough: true }) res: Response) {
    const result = await this.users.revokeSession(auth, params.id);
    if (result.current) this.tokens.clearSessionCookie(res);
    return ok(result);
  }

  @Get('activity')
  async activity(@CurrentUser() auth: AuthContext, @Query() query: PageQueryDto) {
    return this.users.listActivity(auth, query);
  }

  /** Admins: remove the authenticator (current code required), then enroll a new one via /auth/mfa. */
  @Post('mfa/totp/reset')
  @RateLimit('otp')
  @HttpCode(200)
  async resetTotp(@CurrentUser() auth: AuthContext, @Body() body: ResetTotpDto) {
    return ok(await this.users.resetTotp(auth, body.code));
  }
}
