/**
 * Route constants and route-class helpers. Pure module (no React, no browser APIs) so it can be
 * imported from `src/proxy.ts`, server components and client components alike.
 *
 * Slices: when you add a new top-level member or admin route, add it to `routes` and (for member
 * routes) to `MEMBER_ROUTE_PREFIXES` so the proxy protects it. Nested routes under an existing prefix
 * (e.g. `/programs/[id]`) are covered automatically.
 */

/** Name of the HttpOnly session cookie set by the API (`docs/business-rules.md` §2). */
export const SESSION_COOKIE = 'sid';
/** Double-submit CSRF cookie set by `GET /api/v1/auth/csrf`. */
export const CSRF_COOKIE = 'csrf_token';
/** Header the API expects the CSRF token in. */
export const CSRF_HEADER = 'x-csrf-token';

export const routes = {
  home: '/',
  auth: {
    login: '/login',
    register: '/register',
    verifyEmail: '/verify-email',
    forgotPassword: '/forgot-password',
    resetPassword: '/reset-password',
    mfa: '/mfa',
  },
  member: {
    dashboard: '/dashboard',
    programs: '/programs',
    referrals: '/referrals',
    team: '/team',
    sponsor: '/sponsor',
    rewards: '/rewards',
    profile: '/profile',
    notifications: '/notifications',
  },
  admin: {
    overview: '/admin',
    programs: '/admin/programs',
    offerings: '/admin/offerings',
    enrollments: '/admin/enrollments',
    members: '/admin/members',
    events: '/admin/events',
    rewards: '/admin/rewards',
    ledger: '/admin/ledger',
    reconciliation: '/admin/reconciliation',
    flags: '/admin/flags',
    audit: '/admin/audit',
    settings: '/admin/settings',
    integrations: '/admin/integrations',
  },
} as const;

/** Top-level prefixes of the authenticated member area. */
export const MEMBER_ROUTE_PREFIXES: readonly string[] = Object.values(routes.member);
/** Prefix of the admin console. */
export const ADMIN_ROUTE_PREFIX = '/admin';
/** Pages a signed-in user is bounced away from (to `next` or the dashboard). */
export const GUEST_ONLY_ROUTES: readonly string[] = [routes.auth.login, routes.auth.register];
/** Query flag that tells the proxy to show /login even though a (stale) session cookie exists. */
export const SESSION_EXPIRED_PARAM = 'expired';

function matchesPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function isAdminPath(pathname: string): boolean {
  return matchesPrefix(pathname, ADMIN_ROUTE_PREFIX);
}

export function isMemberPath(pathname: string): boolean {
  return MEMBER_ROUTE_PREFIXES.some((prefix) => matchesPrefix(pathname, prefix));
}

/** Routes that require a session cookie (member area + admin console). */
export function isProtectedPath(pathname: string): boolean {
  return isAdminPath(pathname) || isMemberPath(pathname);
}

export function isGuestOnlyPath(pathname: string): boolean {
  return GUEST_ONLY_ROUTES.some((route) => matchesPrefix(pathname, route));
}

/**
 * Returns `value` only if it is a safe same-origin relative path ("/dashboard?x=1"), otherwise null.
 * Prevents open redirects via `?next=https://evil.example` or protocol-relative `//evil.example`.
 */
export function safeNextPath(value: string | null | undefined): string | null {
  if (!value) return null;
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return null;
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) < 0x20) return null; // control characters
  }
  // Never bounce back into auth screens.
  const pathOnly = value.split(/[?#]/)[0] ?? value;
  if (isGuestOnlyPath(pathOnly)) return null;
  return value;
}

/** `/login?next=<path>` (+ `expired=1` when the session was rejected by the API). */
export function loginHref(next?: string | null, options: { expired?: boolean } = {}): string {
  const params = new URLSearchParams();
  const safe = safeNextPath(next);
  if (safe) params.set('next', safe);
  if (options.expired) params.set(SESSION_EXPIRED_PARAM, '1');
  const query = params.toString();
  return query ? `${routes.auth.login}?${query}` : routes.auth.login;
}

/** Second-factor screen for admin sessions that are not MFA-verified yet. */
export function mfaHref(next?: string | null): string {
  const safe = safeNextPath(next);
  return safe ? `${routes.auth.mfa}?next=${encodeURIComponent(safe)}` : routes.auth.mfa;
}
