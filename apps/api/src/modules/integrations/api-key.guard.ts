import { CanActivate, createParamDecorator, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { unauthenticated } from '../../common/errors/app-error';
import { parseBearer } from './domain/api-key';
import { IntegrationsService, type ApiClientPrincipal } from './integrations.service';

type ApiKeyRequest = Request & { apiClient?: ApiClientPrincipal };

/**
 * Authenticates machine requests with `Authorization: Bearer <api key>` (routes must also be
 * `@Public()` + `@SkipCsrf()`: there is no cookie session). Runs before validation, so a bad key
 * always gets 401 regardless of the body.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly integrations: IntegrationsService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<ApiKeyRequest>();
    const client = await this.integrations.authenticate(parseBearer(req.headers.authorization));
    if (!client) throw unauthenticated('Missing, invalid or revoked API key');
    req.apiClient = client;
    return true;
  }
}

/** The API client authenticated by `ApiKeyGuard`. */
export const CurrentApiClient = createParamDecorator((_: unknown, ctx: ExecutionContext): ApiClientPrincipal => {
  const client = ctx.switchToHttp().getRequest<ApiKeyRequest>().apiClient;
  if (!client) throw unauthenticated('Missing, invalid or revoked API key');
  return client;
});
