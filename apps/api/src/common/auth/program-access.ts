import { forbidden } from '../errors/app-error';
import type { AuthContext } from './auth-context';

export type ProgramAccessMode = 'read' | 'write';

/**
 * Program-scoped authorization (call it in services after `@RequirePermissions`):
 * - SUPER_ADMIN: every program, read & write.
 * - PROGRAM_ADMIN: only programs in `auth.programScopes` (assigned via program_admin_assignments).
 * - FINANCE_REVIEWER: read access to every program; never write.
 * - anyone else: denied.
 * Throws 403 FORBIDDEN when denied.
 */
export function assertProgramAccess(auth: AuthContext, programId: string, mode: ProgramAccessMode = 'write'): void {
  if (!canAccessProgram(auth, programId, mode)) {
    throw forbidden('You do not have access to this program');
  }
}

export function canAccessProgram(auth: AuthContext, programId: string, mode: ProgramAccessMode = 'write'): boolean {
  if (auth.roles.includes('SUPER_ADMIN')) return true;
  if (auth.roles.includes('PROGRAM_ADMIN') && auth.programScopes.includes(programId)) return true;
  if (mode === 'read' && auth.roles.includes('FINANCE_REVIEWER')) return true;
  return false;
}

/**
 * For list queries: `'ALL'` when the user may see every program in `mode`, otherwise the explicit list
 * of program ids (possibly empty) to filter by, e.g.
 *   const scope = programScopeFilter(auth, 'read');
 *   where: scope === 'ALL' ? {} : { programId: { in: scope } }
 */
export function programScopeFilter(auth: AuthContext, mode: ProgramAccessMode = 'read'): 'ALL' | string[] {
  if (auth.roles.includes('SUPER_ADMIN')) return 'ALL';
  if (mode === 'read' && auth.roles.includes('FINANCE_REVIEWER')) return 'ALL';
  if (auth.roles.includes('PROGRAM_ADMIN')) return [...auth.programScopes];
  return [];
}
