'use client';

import { PageHeader } from '@/components/app/page-header';

import { ProgramForm } from './program-form';

/** /admin/programs/new — create a DRAFT program. */
export function NewProgramPage() {
  return (
    <div>
      <PageHeader
        title="New program"
        description="Programs start as drafts. Add plans and a reward policy, then publish when everything is ready."
      />
      <ProgramForm />
    </div>
  );
}
