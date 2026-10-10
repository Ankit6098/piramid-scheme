'use client';

import { Bot, History } from 'lucide-react';
import Link from 'next/link';
import { Permission, type AuditLogListItemDto } from '@app/shared';

import { RelativeTime } from '@/components/app/date-time';
import { EmptyState } from '@/components/app/states';
import { UserAvatar } from '@/components/app/user-avatar';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { routes } from '@/config/routes';
import { auditActionLabel, resourceTypeLabel } from '@/features/audit/format';
import { useSession } from '@/hooks/use-session';

/** The latest audit entries in the caller's scope; links into the audit log for `audit:read` holders. */
export function RecentActionsCard({ items, scoped }: { items: readonly AuditLogListItemDto[]; scoped: boolean }) {
  const { can } = useSession();
  const canOpen = can(Permission.AuditRead);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent admin actions</CardTitle>
        <CardDescription>
          {scoped ? 'Latest changes in your programs.' : 'Latest changes recorded in the audit log.'}
        </CardDescription>
        {canOpen ? (
          <CardAction>
            <Button asChild variant="ghost" size="sm">
              <Link href={routes.admin.audit}>Audit log</Link>
            </Button>
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <EmptyState variant="plain" size="sm" icon={History} title="No recorded actions yet" />
        ) : (
          <ol className="space-y-3">
            {items.map((a) => {
              const label = auditActionLabel(a.action);
              return (
                <li key={a.id} className="flex items-start gap-3">
                  {a.actor ? (
                    <UserAvatar name={a.actor.fullName} size="sm" />
                  ) : (
                    <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                      <Bot className="size-3.5" aria-hidden />
                    </span>
                  )}
                  <div className="min-w-0 flex-1 text-sm">
                    <p className="leading-snug">
                      <span className="font-medium">{a.actor?.fullName ?? 'System'}</span>{' '}
                      {canOpen ? (
                        <Link
                          href={`${routes.admin.audit}?entry=${a.id}`}
                          className="text-foreground underline decoration-muted-foreground/40 underline-offset-4 hover:decoration-primary"
                        >
                          {label.charAt(0).toLowerCase() + label.slice(1)}
                        </Link>
                      ) : (
                        <span>{label.charAt(0).toLowerCase() + label.slice(1)}</span>
                      )}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {resourceTypeLabel(a.resourceType)}
                      {a.program ? ` · ${a.program.name}` : ''}
                      {a.reason ? ` · “${a.reason}”` : ''}
                    </p>
                  </div>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    <RelativeTime value={a.createdAt} />
                  </span>
                </li>
              );
            })}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}
