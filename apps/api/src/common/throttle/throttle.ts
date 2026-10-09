import { applyDecorators, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  SkipThrottle,
  Throttle,
  ThrottlerGuard,
  type ThrottlerModuleOptions,
  type ThrottlerStorage,
} from '@nestjs/throttler';
import type { Request } from 'express';
import type { AppConfigShape } from '../../config/app-config';

/**
 * Throttler names:
 * - `default` — applies to every route (THROTTLE_DEFAULT_LIMIT per THROTTLE_DEFAULT_TTL_SECONDS per IP).
 * - `auth`    — strict; applies ONLY to routes marked `@RateLimit('auth')` (login, register, reset…).
 * - `otp`     — strict; applies ONLY to routes marked `@RateLimit('otp')` (OTP send/verify).
 * Per-account/email limits (business rules §2) are the auth slice's job (DB counters), on top of these.
 */
export type ThrottlerName = 'default' | 'auth' | 'otp';
export const OPT_IN_THROTTLERS = ['auth', 'otp'] as const;
export type OptInThrottler = (typeof OPT_IN_THROTTLERS)[number];

export const RATE_LIMIT_KEY = 'app:rateLimits';

const reflector = new Reflector();

/**
 * Opts a route into the strict `auth` / `otp` throttlers (keyed by client IP). Optionally override
 * limit/ttl (ms) for this route.
 * @example @RateLimit('otp', { limit: 3, ttl: 60_000 })
 */
export function RateLimit(name: OptInThrottler, override?: { limit: number; ttl: number }) {
  const decorators: Array<ClassDecorator & MethodDecorator> = [SetMetadata(RATE_LIMIT_KEY, [name])];
  if (override) decorators.push(Throttle({ [name]: override }));
  return applyDecorators(...decorators);
}

/** Disables the default throttler for a route (e.g. health probes). */
export const SkipDefaultThrottle = () => SkipThrottle({ default: true });

function optedIn(context: ExecutionContext, name: OptInThrottler): boolean {
  const names = reflector.getAllAndMerge<string[]>(RATE_LIMIT_KEY, [context.getHandler(), context.getClass()]);
  return names.includes(name);
}

/**
 * Builds ThrottlerModule options. Storage is pluggable: pass any `ThrottlerStorage`
 * (in-memory by default; `RedisThrottlerStorage` when THROTTLE_STORAGE=redis).
 */
export function buildThrottlerOptions(config: AppConfigShape, storage?: ThrottlerStorage): ThrottlerModuleOptions {
  return {
    throttlers: [
      { name: 'default', limit: config.throttle.default.limit, ttl: config.throttle.default.ttlMs },
      {
        name: 'auth',
        limit: config.throttle.auth.limit,
        ttl: config.throttle.auth.ttlMs,
        skipIf: (ctx) => !optedIn(ctx, 'auth'),
      },
      {
        name: 'otp',
        limit: config.throttle.otp.limit,
        ttl: config.throttle.otp.ttlMs,
        skipIf: (ctx) => !optedIn(ctx, 'otp'),
      },
    ],
    ...(storage ? { storage } : {}),
    errorMessage: 'Too many requests',
  };
}

/**
 * Tracks by client IP. `req.ip` honours X-Forwarded-For only when express `trust proxy` is enabled
 * (TRUST_PROXY=true), so clients cannot spoof their address otherwise.
 */
@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  protected override async getTracker(req: Record<string, any>): Promise<string> {
    const r = req as Request;
    if (!r.ip) return r.socket?.remoteAddress ?? 'unknown';
    return super.getTracker(req); // normalizes IPv6 addresses to their /64 subnet
  }
}
