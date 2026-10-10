import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

/**
 * Section heading inside the version panel. Renders an `<h3>` (the page has the `<h1>`, the
 * timeline and the selected version's name are `<h2>`s), styled like the kit's `SectionHeader`.
 */
export function PanelSectionHeader({
  title,
  description,
  actions,
  id,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  id?: string;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-wrap items-end justify-between gap-2', className)}>
      <div className="space-y-0.5">
        <h3 id={id} className="font-heading text-base font-semibold tracking-tight">
          {title}
        </h3>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}
