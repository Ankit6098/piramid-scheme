/**
 * Web-side mirrors of the few API payloads the app core depends on. Feature slices should import
 * their DTO types from `@app/shared` contracts; when `contracts/auth.ts` / `contracts/settings.ts`
 * export equivalent types, these can become re-exports.
 */
import type { Permission, RewardUnit, RoleKey } from '@app/shared';

/** `GET /api/v1/auth/session` → `{ data: { user: SessionUser } }` (401 when signed out). */
export interface SessionUser {
  id: string;
  fullName: string;
  email: string;
  emailVerified: boolean;
  avatarUrl: string | null;
  roles: RoleKey[];
  permissions: Permission[];
  /** Holds at least one non-MEMBER role. */
  isAdmin: boolean;
  /** Admin second factor completed for this session (`/admin/*` endpoints require it). */
  mfaVerified: boolean;
}

export interface SessionResponse {
  user: SessionUser;
}

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
