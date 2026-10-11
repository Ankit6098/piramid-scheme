import { z } from 'zod';

/**
 * Raw environment variables (see the repo-root `.env.example`). Everything is validated at boot;
 * an invalid or missing value aborts startup with a readable list of problems (fail fast).
 */

const bool = (defaultValue: boolean) =>
  z
    .enum(['true', 'false', '1', '0', 'yes', 'no'])
    .default(defaultValue ? 'true' : 'false')
    .transform((v) => v === 'true' || v === '1' || v === 'yes');

const int = (defaultValue: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(defaultValue);

/** 32-byte key as 64 hex characters (AES-256-GCM). Generate: `openssl rand -hex 32`. */
const hexKey32 = (name: string) =>
  z.string().regex(/^[0-9a-fA-F]{64}$/, `${name} must be 64 hex characters (32 bytes): openssl rand -hex 32`);

const postgresUrl = z
  .string()
  .min(1)
  .refine((v) => /^postgres(ql)?:\/\//.test(v), 'Must be a postgres:// or postgresql:// URL');

/** `TRUST_PROXY`: false | true (= 1 hop) | hop count | express "trust proxy" string (e.g. "loopback"). */
const trustProxy = z
  .string()
  .default('false')
  .transform((v): boolean | number | string => {
    const s = v.trim().toLowerCase();
    if (s === '' || s === 'false' || s === '0' || s === 'no') return false;
    if (s === 'true' || s === 'yes') return 1;
    if (/^\d+$/.test(s)) return Number(s);
    return v.trim();
  });

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_PUBLIC_URL: z.url().default('http://localhost:8080'),
  API_PORT: int(4000, 1, 65535),
  CORS_ORIGINS: z.string().default('http://localhost:3000,http://localhost:8080'),
  TRUST_PROXY: trustProxy,

  DATABASE_URL: postgresUrl,
  TEST_DATABASE_URL: postgresUrl.optional(),
  /** Max connections in the pg pool used by Prisma. */
  DATABASE_POOL_MAX: int(10, 1, 200),
  /** Max wait (ms) for a pooled / new DB connection before the request fails with 503. */
  DATABASE_CONNECT_TIMEOUT_MS: int(5_000, 100, 60_000),
  /** Session `statement_timeout` (ms); keep ≤ the 15 s default transaction timeout. */
  DATABASE_STATEMENT_TIMEOUT_MS: int(15_000, 1_000, 600_000),
  /** Session `lock_timeout` (ms) for row and advisory lock waits. */
  DATABASE_LOCK_TIMEOUT_MS: int(5_000, 100, 600_000),

  REDIS_URL: z
    .string()
    .default('redis://localhost:6379')
    .refine((v) => /^rediss?:\/\//.test(v), 'Must be a redis:// or rediss:// URL'),

  OTP_PEPPER: z.string().min(32, 'OTP_PEPPER must be at least 32 characters (use 64 hex chars)'),
  /** AES-256-GCM key for OTP codes carried by outbox email messages (AAD = challenge id). */
  OTP_OUTBOX_KEY: hexKey32('OTP_OUTBOX_KEY'),
  /** AES-256-GCM key for TOTP secrets at rest (user_mfa_factors.secret_enc). */
  MFA_ENCRYPTION_KEY: hexKey32('MFA_ENCRYPTION_KEY'),
  /** Issuer shown in authenticator apps (otpauth:// URI). */
  MFA_TOTP_ISSUER: z.string().min(1).max(64).default('Referral Platform'),
  SESSION_TTL_HOURS: int(168, 1, 24 * 90),
  SESSION_IDLE_TIMEOUT_MINUTES: int(720, 5, 60 * 24 * 30),
  ADMIN_SESSION_TTL_HOURS: int(12, 1, 24 * 7),
  COOKIE_SECURE: bool(false),

  SMTP_HOST: z.string().min(1).default('localhost'),
  SMTP_PORT: int(1025, 1, 65535),
  SMTP_SECURE: bool(false),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  MAIL_FROM: z.string().min(3).default('Referral Platform <no-reply@example.com>'),

  SEED_SUPER_ADMIN_EMAIL: z.string().optional(),
  SEED_SUPER_ADMIN_PASSWORD: z.string().optional(),
  SEED_DEMO_DATA: bool(false),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  /** Run the outbox relay + scheduled jobs inside the API process (dev convenience). */
  RUN_WORKER_IN_API: bool(false),

  /** Rate limiting. Storage `memory` is per-process; use `redis` when running several API replicas. */
  THROTTLE_STORAGE: z.enum(['memory', 'redis']).default('memory'),
  THROTTLE_DEFAULT_LIMIT: int(300, 1, 1_000_000),
  THROTTLE_DEFAULT_TTL_SECONDS: int(60, 1, 86_400),
  THROTTLE_AUTH_LIMIT: int(10, 1, 1_000_000),
  THROTTLE_AUTH_TTL_SECONDS: int(60, 1, 86_400),
  THROTTLE_OTP_LIMIT: int(5, 1, 1_000_000),
  THROTTLE_OTP_TTL_SECONDS: int(60, 1, 86_400),

  /**
   * Login failure backoff (Redis): after N failures per (email-HMAC, IP) — or M per IP — every further
   * failure blocks for BASE·2^k seconds, capped at MAX. Counters expire after WINDOW of inactivity.
   */
  LOGIN_THROTTLE_FREE_ATTEMPTS: int(5, 1, 1000),
  LOGIN_THROTTLE_IP_FREE_ATTEMPTS: int(20, 1, 100_000),
  LOGIN_THROTTLE_BASE_SECONDS: int(30, 1, 3600),
  LOGIN_THROTTLE_MAX_SECONDS: int(900, 1, 86_400),
  LOGIN_THROTTLE_WINDOW_SECONDS: int(86_400, 60, 30 * 86_400),
});

export type RawEnv = z.infer<typeof envSchema>;
