import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';
import { envSchema, type RawEnv } from './env.schema';

/** apps/api (two levels above both src/config and dist/config). */
export const API_ROOT = resolve(__dirname, '..', '..');
export const REPO_ROOT = resolve(API_ROOT, '..', '..');

/**
 * Loads `apps/api/.env` then the repo-root `.env` into `process.env` (never overriding variables that
 * are already set, so real environment variables always win). Safe to call more than once.
 */
export function loadEnvFiles(): void {
  for (const file of [resolve(API_ROOT, '.env'), resolve(REPO_ROOT, '.env')]) {
    if (existsSync(file)) loadDotenv({ path: file, override: false, quiet: true });
  }
}

export interface AppConfigShape {
  readonly env: RawEnv['NODE_ENV'];
  readonly isProduction: boolean;
  readonly isTest: boolean;
  readonly app: {
    readonly publicUrl: string;
    /** Origin (scheme://host:port) of APP_PUBLIC_URL. */
    readonly publicOrigin: string;
    readonly port: number;
    /** Allowed browser origins (CORS + CSRF Origin check). Always includes publicOrigin. */
    readonly corsOrigins: readonly string[];
    /** Value passed to express `trust proxy` (false = ignore X-Forwarded-*). */
    readonly trustProxy: boolean | number | string;
  };
  readonly database: { readonly url: string; readonly poolMax: number };
  readonly redis: { readonly url: string };
  readonly security: {
    readonly otpPepper: string;
    /** 64 hex chars; AES-256-GCM key for OTP ciphertexts in outbox payloads. */
    readonly otpOutboxKeyHex: string;
    /** 64 hex chars; AES-256-GCM key for TOTP secrets at rest. */
    readonly mfaEncryptionKeyHex: string;
    readonly totpIssuer: string;
    readonly sessionTtlHours: number;
    readonly adminSessionTtlHours: number;
    readonly sessionIdleTimeoutMinutes: number;
    readonly cookieSecure: boolean;
  };
  readonly mail: {
    readonly host: string;
    readonly port: number;
    readonly secure: boolean;
    readonly user?: string;
    readonly password?: string;
    readonly from: string;
  };
  readonly seed: {
    readonly superAdminEmail?: string;
    readonly superAdminPassword?: string;
    readonly demoData: boolean;
  };
  readonly log: { readonly level: RawEnv['LOG_LEVEL'] };
  readonly worker: { readonly runInApi: boolean };
  readonly throttle: {
    readonly storage: 'memory' | 'redis';
    readonly default: { readonly limit: number; readonly ttlMs: number };
    readonly auth: { readonly limit: number; readonly ttlMs: number };
    readonly otp: { readonly limit: number; readonly ttlMs: number };
  };
  /** Login failure backoff (see LoginThrottleService). */
  readonly loginThrottle: {
    readonly freeAttempts: number;
    readonly ipFreeAttempts: number;
    readonly baseMs: number;
    readonly maxMs: number;
    readonly windowMs: number;
  };
}

/**
 * Typed, validated configuration. Inject it by class: `constructor(private readonly config: AppConfig)`.
 * (Abstract class + interface merge: the class is only the DI token, the shape is `AppConfigShape`.)
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export abstract class AppConfig {}
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export interface AppConfig extends AppConfigShape {}

export class ConfigValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid environment configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigValidationError';
  }
}

function originOf(url: string): string {
  return new URL(url).origin;
}

/** Parses and validates an env record into `AppConfigShape`. Throws `ConfigValidationError`. */
export function parseConfig(env: Record<string, string | undefined>): AppConfigShape {
  // Treat empty strings as "unset" so optional values like SMTP_USER= work.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
  const parsed = envSchema.safeParse(cleaned);
  if (!parsed.success) {
    throw new ConfigValidationError(
      parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  }
  const e = parsed.data;
  const problems: string[] = [];
  if (e.NODE_ENV === 'production') {
    if (!/^[0-9a-f]{64}$/i.test(e.OTP_PEPPER)) problems.push('OTP_PEPPER: must be 64 hex characters in production');
  }
  const keys = [e.OTP_PEPPER.toLowerCase(), e.OTP_OUTBOX_KEY.toLowerCase(), e.MFA_ENCRYPTION_KEY.toLowerCase()];
  if (new Set(keys).size !== keys.length) {
    problems.push('OTP_PEPPER, OTP_OUTBOX_KEY and MFA_ENCRYPTION_KEY must be three different secrets');
  }
  if (e.LOGIN_THROTTLE_MAX_SECONDS < e.LOGIN_THROTTLE_BASE_SECONDS) {
    problems.push('LOGIN_THROTTLE_MAX_SECONDS must be >= LOGIN_THROTTLE_BASE_SECONDS');
  }

  const corsOrigins = new Set<string>();
  for (const raw of e.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)) {
    const res = z.url().safeParse(raw);
    if (!res.success) {
      problems.push(`CORS_ORIGINS: "${raw}" is not a valid URL`);
      continue;
    }
    corsOrigins.add(originOf(raw));
  }
  const publicOrigin = originOf(e.APP_PUBLIC_URL);
  corsOrigins.add(publicOrigin);
  if (problems.length) throw new ConfigValidationError(problems);

  return {
    env: e.NODE_ENV,
    isProduction: e.NODE_ENV === 'production',
    isTest: e.NODE_ENV === 'test',
    app: {
      publicUrl: e.APP_PUBLIC_URL.replace(/\/+$/, ''),
      publicOrigin,
      port: e.API_PORT,
      corsOrigins: [...corsOrigins],
      trustProxy: e.TRUST_PROXY,
    },
    database: { url: e.DATABASE_URL, poolMax: e.DATABASE_POOL_MAX },
    redis: { url: e.REDIS_URL },
    security: {
      otpPepper: e.OTP_PEPPER,
      otpOutboxKeyHex: e.OTP_OUTBOX_KEY.toLowerCase(),
      mfaEncryptionKeyHex: e.MFA_ENCRYPTION_KEY.toLowerCase(),
      totpIssuer: e.MFA_TOTP_ISSUER,
      sessionTtlHours: e.SESSION_TTL_HOURS,
      adminSessionTtlHours: e.ADMIN_SESSION_TTL_HOURS,
      sessionIdleTimeoutMinutes: e.SESSION_IDLE_TIMEOUT_MINUTES,
      cookieSecure: e.COOKIE_SECURE,
    },
    mail: {
      host: e.SMTP_HOST,
      port: e.SMTP_PORT,
      secure: e.SMTP_SECURE,
      ...(e.SMTP_USER ? { user: e.SMTP_USER } : {}),
      ...(e.SMTP_PASSWORD ? { password: e.SMTP_PASSWORD } : {}),
      from: e.MAIL_FROM,
    },
    seed: {
      ...(e.SEED_SUPER_ADMIN_EMAIL ? { superAdminEmail: e.SEED_SUPER_ADMIN_EMAIL } : {}),
      ...(e.SEED_SUPER_ADMIN_PASSWORD ? { superAdminPassword: e.SEED_SUPER_ADMIN_PASSWORD } : {}),
      demoData: e.SEED_DEMO_DATA,
    },
    log: { level: e.LOG_LEVEL },
    worker: { runInApi: e.RUN_WORKER_IN_API },
    throttle: {
      storage: e.THROTTLE_STORAGE,
      default: { limit: e.THROTTLE_DEFAULT_LIMIT, ttlMs: e.THROTTLE_DEFAULT_TTL_SECONDS * 1000 },
      auth: { limit: e.THROTTLE_AUTH_LIMIT, ttlMs: e.THROTTLE_AUTH_TTL_SECONDS * 1000 },
      otp: { limit: e.THROTTLE_OTP_LIMIT, ttlMs: e.THROTTLE_OTP_TTL_SECONDS * 1000 },
    },
    loginThrottle: {
      freeAttempts: e.LOGIN_THROTTLE_FREE_ATTEMPTS,
      ipFreeAttempts: e.LOGIN_THROTTLE_IP_FREE_ATTEMPTS,
      baseMs: e.LOGIN_THROTTLE_BASE_SECONDS * 1000,
      maxMs: e.LOGIN_THROTTLE_MAX_SECONDS * 1000,
      windowMs: e.LOGIN_THROTTLE_WINDOW_SECONDS * 1000,
    },
  };
}

/** Loads .env files, then validates `process.env`. Used by main.ts / worker.ts / the config module. */
export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfigShape {
  if (env === process.env) loadEnvFiles();
  return parseConfig(env);
}
