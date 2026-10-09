/**
 * Next.js 16 Proxy (formerly `middleware`). Cookie-presence routing only — it never validates the
 * session; the API does that on every request and <RequireAuth> handles expired sessions.
 *
 * - No `sid` cookie + member/admin route → redirect to `/login?next=<path>`.
 * - `sid` cookie + /login or /register → redirect to `next` (if safe) or the dashboard, unless the
 *   client flagged the session as expired (`?expired=1`), which avoids a redirect loop on a stale cookie.
 */
import { NextResponse, type NextRequest } from 'next/server';

import {
  SESSION_COOKIE,
  SESSION_EXPIRED_PARAM,
  isGuestOnlyPath,
  isProtectedPath,
  routes,
  safeNextPath,
} from '@/config/routes';

export function proxy(request: NextRequest) {
  const { pathname, search, searchParams } = request.nextUrl;
  const hasSession = Boolean(request.cookies.get(SESSION_COOKIE)?.value);

  if (!hasSession && isProtectedPath(pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = routes.auth.login;
    url.search = '';
    url.searchParams.set('next', `${pathname}${search}`);
    return NextResponse.redirect(url);
  }

  if (hasSession && isGuestOnlyPath(pathname) && !searchParams.has(SESSION_EXPIRED_PARAM)) {
    const target = safeNextPath(searchParams.get('next')) ?? routes.member.dashboard;
    return NextResponse.redirect(new URL(target, request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    // Everything except the API (proxied to NestJS), Next internals and static files.
    '/((?!api/|_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|.*\\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico|txt|xml|webmanifest|woff2?)$).*)',
  ],
};
