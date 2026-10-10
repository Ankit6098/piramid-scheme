'use client';

import { useParams } from 'next/navigation';

import { SectionHeader } from '@/components/app/page-header';
import { EmptyState } from '@/components/app/states';

import { useAdminProgram } from '../../api';
import { ProgramForm } from './program-form';

/** /admin/programs/[id]/edit — edit the fields allowed in the program's current status. */
export function EditProgramPage() {
  const { id } = useParams<{ id: string }>();
  const { data: program } = useAdminProgram(id);
  if (!program) return null;
  if (program.editableFields.length === 0) {
    return <EmptyState title="This program is read-only" description="Archived programs can no longer be edited." />;
  }
  return (
    <div className="space-y-4">
      <SectionHeader title="Edit program" description="Changes are audited. Concurrent edits are detected and you will be asked to reload." />
      <ProgramForm program={program} />
    </div>
  );
}
