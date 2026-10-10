import { isAdminRole, type RoleKey } from '@app/shared';

import { StatusBadge } from '@/components/app/status-badge';
import { cn } from '@/lib/utils';

/** Administrative roles as badges; plain members show a single muted "Member" label. */
export function RoleBadges({ roles, className }: { roles: readonly RoleKey[]; className?: string }) {
  const adminRoles = roles.filter(isAdminRole);
  if (adminRoles.length === 0) {
    return <span className={cn('text-xs text-muted-foreground', className)}>Member</span>;
  }
  return (
    <span className={cn('inline-flex flex-wrap gap-1', className)}>
      {adminRoles.map((role) => (
        <StatusBadge key={role} kind="RoleKey" value={role} />
      ))}
    </span>
  );
}
