/** Pure display helpers for the profile screens. */

const BROWSERS: Array<[RegExp, string]> = [
  [/Edg(e|A|iOS)?\//, 'Edge'],
  [/OPR\/|Opera/, 'Opera'],
  [/SamsungBrowser\//, 'Samsung Internet'],
  [/Firefox\/|FxiOS\//, 'Firefox'],
  [/Chrome\/|CriOS\//, 'Chrome'],
  [/Safari\//, 'Safari'],
];

const SYSTEMS: Array<[RegExp, string]> = [
  [/Windows/, 'Windows'],
  [/iPhone|iPad|iPod/, 'iOS'],
  [/Android/, 'Android'],
  [/Mac OS X|Macintosh/, 'macOS'],
  [/CrOS/, 'ChromeOS'],
  [/Linux/, 'Linux'],
];

/** "Chrome on Windows" from a user-agent string (best effort; falls back to "Unknown device"). */
export function describeUserAgent(ua: string | null | undefined): string {
  if (!ua) return 'Unknown device';
  const browser = BROWSERS.find(([re]) => re.test(ua))?.[1];
  const system = SYSTEMS.find(([re]) => re.test(ua))?.[1];
  if (browser && system) return `${browser} on ${system}`;
  return browser ?? system ?? (ua.length > 40 ? `${ua.slice(0, 40)}…` : ua);
}

const ACTIVITY_LABELS: Record<string, string> = {
  'user.register': 'Account created',
  'auth.login': 'Signed in',
  'auth.logout': 'Signed out',
  'auth.mfa.email_verified': 'Email code verified',
  'auth.mfa.totp_setup_started': 'Authenticator setup started',
  'auth.mfa.totp_enrolled': 'Authenticator app added',
  'auth.mfa.totp_verified': 'Two-step verification completed',
  'auth.password_reset.blocked_admin': 'Password reset request blocked',
  'user.profile.update': 'Profile updated',
  'user.password.change': 'Password changed',
  'user.password.reset': 'Password reset by email code',
  'user.email_change.requested': 'Email change requested',
  'user.email.change': 'Email address changed',
  'user.session.revoke': 'Session signed out',
  'user.sessions.revoke_others': 'Other sessions signed out',
  'user.mfa.totp_reset': 'Authenticator app removed',
};

/** Human label for an audit action; unknown actions are humanized (`enrollment.cancel` → "Enrollment cancel"). */
export function activityLabel(action: string): string {
  const known = ACTIVITY_LABELS[action];
  if (known) return known;
  const words = action.replace(/[._]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : action;
}
