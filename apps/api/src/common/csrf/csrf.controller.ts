import { Controller, Get, Res } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../auth/decorators';
import { SessionTokenService } from '../auth/session-token.service';
import { ok } from '../http/envelope';

/**
 * Core-owned endpoint (the auth slice owns the rest of /auth). Issues a fresh `csrf_token` cookie
 * (non-HttpOnly, SameSite=Lax) and returns the same value; the SPA sends it back in `x-csrf-token`.
 */
@ApiTags('auth')
@Controller('auth')
export class CsrfController {
  constructor(private readonly tokens: SessionTokenService) {}

  @Public()
  @Get('csrf')
  @ApiOkResponse({ description: '{ data: { csrfToken } }' })
  csrf(@Res({ passthrough: true }) res: Response): { data: { csrfToken: string } } {
    res.setHeader('Cache-Control', 'no-store');
    return ok({ csrfToken: this.tokens.issueCsrfToken(res) });
  }
}
