/**
 * Web-side mirrors of the few API payloads the app core depends on. Feature slices should import
 * their DTO types from `@app/shared` contracts; when `contracts/auth.ts` / `contracts/settings.ts`
 * export equivalent types, these can become re-exports.
 */
import type { RewardUnit, SessionResponseDto, SessionUserDto } from '@app/shared';

/**
 * `GET /api/v1/auth/session` → `{ data: { user: SessionUser } }` (401 when signed out). Defined by the
 * auth contract (`@app/shared` `SessionUserDto`): roles/permissions, `isAdmin`, `adminAccess` (admin
 * role + TOTP verified in this session within 12 h — required for `/admin/*`), `mfaMethod` (second
 * factor completed in this session) and `hasTotpFactor` (an authenticator app is enrolled).
 */
export type SessionUser = SessionUserDto;

export type SessionResponse = SessionResponseDto;

/** `GET /api/v1/settings/public` → `{ data: PublicSettings }` (no auth required). */
export interface PublicSettings {
  rewardUnit: RewardUnit;
  currencyCode: string;
  currencyMinorUnits: number;
  pointsLabel: string;
}

/** `GET /api/v1/auth/csrf` → `{ data: { csrfToken } }` (also sets the `csrf_token` cookie). */
export interface CsrfResponse {
  csrfToken: string;
}
