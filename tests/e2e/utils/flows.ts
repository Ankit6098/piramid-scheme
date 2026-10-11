/**
 * Reusable UI flows: registration + email verification, sign-in, admin MFA (email code → TOTP
 * enrollment, or TOTP verification with the stored secret) and small API helpers that reuse the
 * browser context's cookies (CSRF double-submit + Origin, like the web app's api-client).
 */
import { randomBytes } from 'node:crypto';

import { expect, type APIResponse, type BrowserContext, type Page } from '@playwright/test';

import { waitForOtp } from './mailpit';
import { getTotpRecord, saveTotpRecord } from './state';
import { nextTotp, secretFromOtpauth } from './totp';

/** Short unique id for this run (codes, emails, external ids). Upper-case alphanumerics. */
export function uniqueId(length = 6): string {
  return randomBytes(16).toString('hex').toUpperCase().slice(0, length);
}

export function uniqueEmail(label: string): string {
  return `e2e-${label}-${Date.now().toString(36)}-${uniqueId(4).toLowerCase()}@example.test`;
}

export const MEMBER_PASSWORD = 'E2e-member-pass-42';

export function adminCredentials(): { email: string; password: string } {
  const email =
    process.env.E2E_ADMIN_EMAIL ?? process.env.SEED_SUPER_ADMIN_EMAIL ?? 'admin@example.com';
  const password = process.env.E2E_ADMIN_PASSWORD ?? process.env.SEED_SUPER_ADMIN_PASSWORD;
  if (!password) {
    throw new Error(
      'Set E2E_ADMIN_PASSWORD (or SEED_SUPER_ADMIN_PASSWORD) to the seeded super admin password',
    );
  }
  return { email, password };
}

/** Seeded demo accounts (SEED_DEMO_DATA=true) share this password (apps/api/prisma/seed.ts). */
export const DEMO_PASSWORD =
  process.env.E2E_DEMO_PASSWORD ?? process.env.SEED_DEMO_PASSWORD ?? 'Demo@12345678';

// ─── Registration ────────────────────────────────────────────────────────────

export interface RegisterInput {
  fullName: string;
  email: string;
  password?: string;
  referralCode?: string;
}

/** Fills and submits /register (optionally /register?ref=CODE). Ends on /verify-email. */
export async function submitRegistration(
  page: Page,
  input: RegisterInput,
  viaLink = true,
): Promise<void> {
  const url =
    input.referralCode && viaLink
      ? `/register?ref=${encodeURIComponent(input.referralCode)}`
      : '/register';
  await page.goto(url);
  await expect(page.getByRole('heading', { level: 1, name: 'Create your account' })).toBeVisible();
  await page.getByLabel('Full name').fill(input.fullName);
  await page.getByLabel('Email').fill(input.email);
  await page.locator('input[name="password"]:visible').fill(input.password ?? MEMBER_PASSWORD);
  if (input.referralCode && !viaLink) {
    await page.getByLabel('Referral code (optional)').fill(input.referralCode);
  }
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL('**/verify-email');
  await expect(page.getByRole('heading', { level: 1, name: 'Check your email' })).toBeVisible();
}

/**
 * On /verify-email: enters the password and the code and waits for the verification request.
 * Returns its HTTP status (200 = verified; the page then reloads to /dashboard).
 */
export async function enterVerification(
  page: Page,
  code: string,
  password = MEMBER_PASSWORD,
): Promise<number> {
  const isVerify = (r: { method(): string; url(): string }) =>
    r.method() === 'POST' && new URL(r.url()).pathname === '/api/v1/auth/verify-email';
  const request = page.waitForRequest(isVerify);
  const response = page.waitForResponse((r) => isVerify(r.request()));
  // Password first: once it is filled, completing the 6-digit code submits the form by itself.
  await page.getByRole('textbox', { name: 'Confirm your password' }).fill(password);
  await page.getByLabel('Verification code').fill(code);
  // The server can take a few seconds (argon2) — only click if the form did not submit itself.
  const autoSubmitted = await Promise.race([
    request.then(() => true),
    page.waitForTimeout(2_000).then(() => false),
  ]);
  if (!autoSubmitted) await page.getByRole('button', { name: 'Verify and continue' }).click();
  return (await response).status();
}

/** Registers and verifies a member through the UI; ends signed in on /dashboard. */
export async function registerAndVerify(page: Page, input: RegisterInput): Promise<void> {
  const since = new Date();
  await submitRegistration(page, input);
  const code = await waitForOtp(input.email, { since, subject: 'Verify your email address' });
  await enterVerification(page, code, input.password ?? MEMBER_PASSWORD);
  await page.waitForURL('**/dashboard');
  await expect(page.getByRole('heading', { level: 1, name: /^Welcome back/ })).toBeVisible();
}

// ─── Sign-in ─────────────────────────────────────────────────────────────────

export async function fillLogin(
  page: Page,
  email: string,
  password: string,
  next?: string,
): Promise<void> {
  await page.goto(next ? `/login?next=${encodeURIComponent(next)}` : '/login');
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
  await page.getByLabel('Email').fill(email);
  await page.locator('input[name="password"]:visible').fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

/** Member sign-in; ends on /dashboard (or `next`). */
export async function signInMember(
  page: Page,
  email: string,
  password = MEMBER_PASSWORD,
  next?: string,
): Promise<void> {
  await fillLogin(page, email, password, next);
  await page.waitForURL(next ? `**${next}` : '**/dashboard');
}

export interface AdminSignInResult {
  /** True when this sign-in enrolled the authenticator (first admin sign-in). */
  enrolled: boolean;
}

/**
 * Admin sign-in through /mfa. First time: email code → authenticator setup (secret read from the
 * "Setup key" element) → first TOTP code → /admin. Later: TOTP code from the stored secret.
 */
export async function signInAdmin(
  page: Page,
  email: string,
  password: string,
): Promise<AdminSignInResult> {
  await fillLogin(page, email, password);
  await page.waitForURL(/\/mfa(\?|$)/);

  const emailStep = page.getByRole('heading', { level: 1, name: "Confirm it's you" });
  const setupStep = page.getByRole('heading', { level: 1, name: 'Set up your authenticator' });
  const verifyStep = page.getByRole('heading', { level: 1, name: 'Two-step verification' });
  await expect(emailStep.or(setupStep).or(verifyStep)).toBeVisible();

  if (await verifyStep.isVisible()) {
    const record = getTotpRecord(email);
    if (!record) {
      throw new Error(
        `${email} already has an authenticator but its secret is not in tests/e2e/.state/totp.json — ` +
          'reset the e2e stack (docker compose … down -v) or restore the state file',
      );
    }
    const { code, step } = await nextTotp(record.secret, record.lastStep);
    saveTotpRecord(email, { secret: record.secret, lastStep: step });
    await page.getByLabel('Authenticator code').fill(code); // auto-submits at 6 digits
    await page.waitForURL(/\/admin(\/|\?|$)/);
    return { enrolled: false };
  }

  if (await emailStep.isVisible()) {
    let since = new Date();
    const sent = page.getByText(/We sent a 6-digit code to/);
    const cooldown = page.getByRole('alert').filter({ hasText: /try again in \d+ s/ });
    await page.getByRole('button', { name: 'Email me a code' }).click();
    await expect(sent.or(cooldown)).toBeVisible();
    if (await cooldown.isVisible()) {
      // A code was requested for this address less than 60 s ago (e.g. by an aborted earlier run).
      const seconds = Number(/try again in (\d+) s/.exec(await cooldown.innerText())?.[1] ?? '60');
      await page.waitForTimeout((seconds + 1) * 1000);
      since = new Date();
      await page.getByRole('button', { name: 'Email me a code' }).click();
      await expect(sent).toBeVisible();
    }
    const code = await waitForOtp(email, { since, subject: 'Your sign-in verification code' });
    await page.getByLabel('Email code').fill(code); // auto-submits at 6 digits
    await expect(setupStep).toBeVisible();
  }

  await page.getByRole('button', { name: 'Show QR code' }).click();
  await expect(page.getByRole('img', { name: /QR code to add/ })).toBeVisible();
  const secret = secretFromOtpauth(
    (await page.getByLabel('Setup key', { exact: true }).innerText()).replace(/\s+/g, ''),
  );
  expect(secret).toMatch(/^[A-Z2-7]{32}$/);
  const { code, step } = await nextTotp(secret, null);
  saveTotpRecord(email, { secret, lastStep: step });
  await page.getByLabel('Authenticator code').fill(code); // auto-submits at 6 digits
  await page.waitForURL(/\/admin(\/|\?|$)/);
  return { enrolled: true };
}

export async function signOut(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^Account menu for/ }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await page.waitForURL('**/login**');
}

// ─── API (with the context's cookies) ────────────────────────────────────────

async function csrfToken(context: BrowserContext, baseURL: string): Promise<string> {
  const fromCookie = (await context.cookies(baseURL)).find((c) => c.name === 'csrf_token')?.value;
  if (fromCookie) return decodeURIComponent(fromCookie);
  const res = await context.request.get(`${baseURL}/api/v1/auth/csrf`);
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { data: { csrfToken: string } };
  return body.data.csrfToken;
}

export async function apiGet(page: Page, path: string): Promise<APIResponse> {
  return page
    .context()
    .request.get(apiUrl(page, path), { headers: { Accept: 'application/json' } });
}

export async function apiSend(
  page: Page,
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  data?: unknown,
  headers: Record<string, string> = {},
): Promise<APIResponse> {
  const base = baseOf(page);
  const token = await csrfToken(page.context(), base);
  return page.context().request.fetch(apiUrl(page, path), {
    method,
    data,
    headers: { Accept: 'application/json', Origin: base, 'x-csrf-token': token, ...headers },
  });
}

function baseOf(page: Page): string {
  const url = new URL(
    page.url().startsWith('http')
      ? page.url()
      : (process.env.E2E_BASE_URL ?? 'http://localhost:8080'),
  );
  return url.origin;
}

function apiUrl(page: Page, path: string): string {
  return `${baseOf(page)}/api/v1${path.startsWith('/') ? path : `/${path}`}`;
}
