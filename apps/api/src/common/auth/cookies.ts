import type { CookieOptions, Response } from 'express';

export const SESSION_COOKIE = 'sid';
export const CSRF_COOKIE = 'csrf_token';
export const CSRF_HEADER = 'x-csrf-token';

export interface CookieSettings {
  secure: boolean;
}

function base(settings: CookieSettings): CookieOptions {
  return { secure: settings.secure, sameSite: 'lax', path: '/' };
}

/** Sets the opaque session cookie: HttpOnly, SameSite=Lax, Secure per COOKIE_SECURE, path=/. */
export function setSessionCookie(res: Response, token: string, expires: Date, settings: CookieSettings): void {
  res.cookie(SESSION_COOKIE, token, { ...base(settings), httpOnly: true, expires });
}

export function clearSessionCookie(res: Response, settings: CookieSettings): void {
  res.clearCookie(SESSION_COOKIE, { ...base(settings), httpOnly: true });
}

/** CSRF double-submit cookie: readable by the SPA (NOT HttpOnly), SameSite=Lax, session-lifetime. */
export function setCsrfCookie(res: Response, token: string, settings: CookieSettings): void {
  res.cookie(CSRF_COOKIE, token, { ...base(settings), httpOnly: false });
}

export function clearCsrfCookie(res: Response, settings: CookieSettings): void {
  res.clearCookie(CSRF_COOKIE, { ...base(settings), httpOnly: false });
}
