'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Permission } from '@app/shared';

import { Can } from '@/components/app/guards';
import { SectionHeader } from '@/components/app/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

import { useAdminProgram } from '../../api';
import { StatusTimeline } from './status-timeline';

/** /admin/programs/[id]/history — full status timeline (from `program_status_changes`). */
export function ProgramHistoryTab() {
  const { id } = useParams<{ id: string }>();
  const { data: program } = useAdminProgram(id);
  if (!program) return null;
  return (
    <div className="space-y-4">
      <SectionHeader
        title="Status history"
        description={`Every lifecycle change with who made it and why. Times in ${program.timezone}.`}
        actions={
          <Can perm={Permission.AuditRead}>
            <Button variant="outline" size="sm" asChild>
              <Link href={`/admin/audit?programId=${encodeURIComponent(program.id)}`}>Full audit log</Link>
            </Button>
          </Can>
        }
      />
      <Card>
        <CardContent>
          <StatusTimeline changes={program.statusHistory} timeZone={program.timezone} />
        </CardContent>
      </Card>
    </div>
  );
}
