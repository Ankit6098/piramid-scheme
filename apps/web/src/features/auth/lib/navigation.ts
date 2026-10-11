/**
 * Post-authentication navigation and small browser helpers for the auth screens.
 *
 * After a successful login / registration / MFA step the client state of the previous user must not
 * survive (Cache Components keep hidden routes mounted), so we clear the query cache and HARD-navigate.
 */
import type { QueryClient } from '@tanstack/react-query';
import type { SessionUserDto } from '@app/shared';

import { isAdminPath, mfaHref, routes, safeNextPath } from '@/config/routes';
import { resetCsrfToken } from '@/lib/api-client';

/**
 * Where a signed-in user goes next:
 * - admin with admin access → `next` (if safe) or the admin console;
 * - admin still needing MFA who asked for an admin page → the MFA screen (keeps `next`);
 * - everyone else → `next` (if safe and not an admin page) or the member dashboard.
 */
export function destinationAfterAuth(
  user: SessionUserDto,
  next: string | null | undefined,
): string {
  const safe = safeNextPath(next);
  const pathOnly = safe?.split(/[?#]/)[0] ?? '';
  if (user.isAdmin && user.adminAccess) return safe ?? routes.admin.overview;
  if (safe && isAdminPath(pathOnly)) return user.isAdmin ? mfaHref(safe) : routes.member.dashboard;
  return safe ?? routes.member.dashboard;
}

/** Clears every cached query (and the cached CSRF token) and hard-navigates to `href`. */
export function hardNavigate(queryClient: QueryClient, href: string): void {
  queryClient.clear();
  resetCsrfToken();
  window.location.assign(href);
}

/** One-off confirmations the /mfa screen shows after a full page load (a toast would be lost). */
export const MFA_NOTICE_PARAM = 'notice';
export const MfaNotice = { TotpRemoved: 'totp-removed' } as const;
export type MfaNotice = (typeof MfaNotice)[keyof typeof MfaNotice];

/** `/mfa?next=…&notice=…`. */
export function mfaNoticeHref(next: string, notice: MfaNotice): string {
  const href = mfaHref(next);
  return `${href}${href.includes('?') ? '&' : '?'}${MFA_NOTICE_PARAM}=${encodeURIComponent(notice)}`;
}

const PENDING_EMAIL_KEY = 'auth:pending-email';

/**
 * Remembers the address a code was sent to between screens (register → verify, forgot → reset)
 * without putting it in the URL (history, logs). Per-tab; failures are ignored.
 */
export function rememberPendingEmail(email: string): void {
  try {
    window.sessionStorage.setItem(PENDING_EMAIL_KEY, email);
  } catch {
    // storage unavailable (private mode) — the next screen asks for the address again
  }
}

export function readPendingEmail(): string {
  try {
    return window.sessionStorage.getItem(PENDING_EMAIL_KEY) ?? '';
  } catch {
    return '';
  }
}

export function forgetPendingEmail(): void {
  try {
    window.sessionStorage.removeItem(PENDING_EMAIL_KEY);
  } catch {
    // ignore
  }
}
