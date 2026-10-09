// Role and permission catalogue. The seed writes these to the roles/permissions tables;
// the API's PermissionsGuard checks keys from this file.

export const RoleKey = ['SUPER_ADMIN', 'PROGRAM_ADMIN', 'FINANCE_REVIEWER', 'MEMBER'] as const;
export type RoleKey = (typeof RoleKey)[number];

export const Permission = {
  SettingsWrite: 'settings:write',
  RolesAssign: 'roles:assign',
  OfferingsWrite: 'offerings:write',
  OfferingsApprove: 'offerings:approve',
  ProgramsRead: 'programs:read',
  ProgramsWrite: 'programs:write',
  ProgramsPublish: 'programs:publish',
  PoliciesWrite: 'policies:write',
  PoliciesPublish: 'policies:publish',
  PoliciesAutoApprove: 'policies:auto-approve',
  EnrollmentsManage: 'enrollments:manage',
  MembersRead: 'members:read',
  MembersWrite: 'members:write',
  ReferralsCorrect: 'referrals:correct',
  EventsWrite: 'events:write',
  EventsReverse: 'events:reverse',
  RewardsRead: 'rewards:read',
  RewardsApprove: 'rewards:approve',
  RewardsReverse: 'rewards:reverse',
  LedgerRead: 'ledger:read',
  ReconciliationRead: 'reconciliation:read',
  ReportsExport: 'reports:export',
  AuditRead: 'audit:read',
  FlagsManage: 'flags:manage',
  IntegrationsManage: 'integrations:manage',
} as const;
export type Permission = (typeof Permission)[keyof typeof Permission];

export const ALL_PERMISSIONS: readonly Permission[] = Object.values(Permission);

export const PERMISSION_DESCRIPTIONS: Record<Permission, string> = {
  'settings:write': 'Change platform-wide settings (reward unit, currency)',
  'roles:assign': 'Grant and revoke administrative roles',
  'offerings:write': 'Create and edit products/services (new ones start inactive)',
  'offerings:approve': 'Approve products/services so they can be used by programs',
  'programs:read': 'View programs and their configuration',
  'programs:write': 'Create and edit programs and options',
  'programs:publish': 'Publish, pause, resume, complete and archive programs',
  'policies:write': 'Draft reward policies and run dry-run previews',
  'policies:publish': 'Publish and retire reward policy versions',
  'policies:auto-approve': 'Publish policies whose rewards skip manual approval',
  'enrollments:manage': 'Activate, reject and review enrollments',
  'members:read': 'View member profiles, enrollments and team structure',
  'members:write': 'Suspend and reactivate members',
  'referrals:correct': 'Correct referral attribution (audited)',
  'events:write': 'Record qualifying sale events',
  'events:reverse': 'Reverse qualifying events (refunds, chargebacks)',
  'rewards:read': 'View rewards across members',
  'rewards:approve': 'Approve and reject rewards',
  'rewards:reverse': 'Reverse posted rewards',
  'ledger:read': 'View ledger transactions and balances',
  'reconciliation:read': 'View reconciliation reports',
  'reports:export': 'Export CSV reports',
  'audit:read': 'View the audit log',
  'flags:manage': 'Raise and resolve suspicious-activity flags',
  'integrations:manage': 'Create and revoke API clients that submit sales',
};

export const ROLE_PERMISSIONS: Record<RoleKey, readonly Permission[]> = {
  SUPER_ADMIN: ALL_PERMISSIONS,
  // Least privilege: no global data (audit, flags, offerings) and no self-approving policies.
  PROGRAM_ADMIN: [
    'programs:read',
    'programs:write',
    'programs:publish',
    'policies:write',
    'policies:publish',
    'enrollments:manage',
    'members:read',
    'events:write',
    'rewards:read',
  ],
  FINANCE_REVIEWER: [
    'programs:read',
    'members:read',
    'events:reverse',
    'rewards:read',
    'rewards:approve',
    'rewards:reverse',
    'ledger:read',
    'reconciliation:read',
    'reports:export',
    'audit:read',
  ],
  MEMBER: [],
};

export const ROLE_LABELS: Record<RoleKey, string> = {
  SUPER_ADMIN: 'Super Admin',
  PROGRAM_ADMIN: 'Program Admin',
  FINANCE_REVIEWER: 'Finance Reviewer',
  MEMBER: 'Member',
};

/** Roles whose permissions are limited to programs they are assigned to. */
export const PROGRAM_SCOPED_ROLES: readonly RoleKey[] = ['PROGRAM_ADMIN'];

export const ADMIN_ROLES: readonly RoleKey[] = ['SUPER_ADMIN', 'PROGRAM_ADMIN', 'FINANCE_REVIEWER'];

export function isAdminRole(role: string): boolean {
  return (ADMIN_ROLES as readonly string[]).includes(role);
}
