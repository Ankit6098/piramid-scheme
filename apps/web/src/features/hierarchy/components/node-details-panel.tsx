'use client';

import { Crosshair, ExternalLink, GitBranch, MousePointerClick } from 'lucide-react';
import Link from 'next/link';

import { DateTime } from '@/components/app/date-time';
import { StatusBadge } from '@/components/app/status-badge';
import { UserAvatar } from '@/components/app/user-avatar';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { routes } from '@/config/routes';

import { EnrollmentIndicator, MemberStatusBadge } from '../../referrals/components/member-status';
import { nodeLabel, type ModelNode } from '../model';

export interface NodeDetailsPanelProps {
  node: ModelNode | null;
  admin: boolean;
  rootLabel: string;
  isViewRoot: boolean;
  onShowFrom: (id: string) => void;
  onCenter: (id: string) => void;
  className?: string;
}

/** Details of the selected member — only the fields the viewer may see. */
export function NodeDetailsPanel({ node, admin, rootLabel, isViewRoot, onShowFrom, onCenter, className }: NodeDetailsPanelProps) {
  if (!node) {
    return (
      <Card size="sm" className={className}>
        <CardContent className="flex flex-col items-center gap-2 py-6 text-center text-sm text-muted-foreground">
          <MousePointerClick className="size-5" aria-hidden />
          Select a member in the tree to see details.
        </CardContent>
      </Card>
    );
  }

  return (
    <Card size="sm" className={className} aria-live="polite">
      <CardHeader>
        <CardDescription>{node.depth === 0 ? rootLabel : `Level ${node.depth}`}</CardDescription>
        <CardTitle className="flex items-center gap-2.5">
          <UserAvatar name={nodeLabel(node)} size="sm" />
          <span className="min-w-0 truncate">{nodeLabel(node)}</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 text-sm">
          <dt className="text-muted-foreground">Joined</dt>
          <dd>
            <DateTime value={node.joinedAt} style="date" />
          </dd>
          <dt className="text-muted-foreground">Account</dt>
          <dd>
            {admin && node.status ? <StatusBadge kind="UserStatus" value={node.status} /> : <MemberStatusBadge value={node.statusBucket} />}
          </dd>
          <dt className="text-muted-foreground">Enrollment</dt>
          <dd>
            <EnrollmentIndicator eligible={node.hasEligibleEnrollment} />
          </dd>
          <dt className="text-muted-foreground">Direct referrals</dt>
          <dd className="tabular-nums">{node.childCount}</dd>
        </dl>
        {admin && node.inScope === false ? (
          <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
            This member is not enrolled in your programs, so only limited details are shown.
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => onCenter(node.id)}>
            <Crosshair aria-hidden />
            Center
          </Button>
          {node.childCount > 0 && !isViewRoot ? (
            <Button type="button" variant="outline" size="sm" onClick={() => onShowFrom(node.id)}>
              <GitBranch aria-hidden />
              Show branch only
            </Button>
          ) : null}
          {admin && node.inScope !== false && node.depth > 0 ? (
            <Button asChild variant="outline" size="sm">
              <Link href={`${routes.admin.members}/${node.id}/team`}>
                <ExternalLink aria-hidden />
                Open this member
              </Link>
            </Button>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
