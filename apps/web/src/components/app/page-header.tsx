import Link from 'next/link';
import { Fragment, type ReactNode } from 'react';

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { cn } from '@/lib/utils';

export interface PageBreadcrumb {
  label: string;
  /** Omit for the current page. */
  href?: string;
}

export interface PageHeaderProps {
  /** Page title — rendered as the page's single <h1>. */
  title: ReactNode;
  /** One or two sentences explaining the page. */
  description?: ReactNode;
  /** Primary/secondary actions (buttons), right-aligned on desktop, wrapped below on mobile. */
  actions?: ReactNode;
  /**
   * In-page breadcrumbs (optional — the top bar already shows automatic ones). Useful for deep
   * detail pages that want an explicit trail, e.g. Programs › Summer Promo › Policy v3.
   */
  breadcrumbs?: readonly PageBreadcrumb[];
  /** Small content under the title row (status badges, meta). */
  meta?: ReactNode;
  className?: string;
}

/** Standard page heading block. Use exactly one per page, as the first child. */
export function PageHeader({
  title,
  description,
  actions,
  breadcrumbs,
  meta,
  className,
}: PageHeaderProps) {
  return (
    <div data-slot="page-header" className={cn('mb-6 flex flex-col gap-3', className)}>
      {breadcrumbs && breadcrumbs.length > 0 ? (
        <Breadcrumb>
          <BreadcrumbList>
            {breadcrumbs.map((crumb, index) => (
              <Fragment key={`${crumb.label}-${index}`}>
                {index > 0 ? <BreadcrumbSeparator /> : null}
                <BreadcrumbItem>
                  {crumb.href ? (
                    <BreadcrumbLink asChild>
                      <Link href={crumb.href}>{crumb.label}</Link>
                    </BreadcrumbLink>
                  ) : (
                    <BreadcrumbPage>{crumb.label}</BreadcrumbPage>
                  )}
                </BreadcrumbItem>
              </Fragment>
            ))}
          </BreadcrumbList>
        </Breadcrumb>
      ) : null}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <h1 className="font-heading text-2xl font-semibold tracking-tight text-foreground">
            {title}
          </h1>
          {description ? (
            <p className="max-w-2xl text-sm text-muted-foreground">{description}</p>
          ) : null}
          {meta ? <div className="flex flex-wrap items-center gap-2 pt-1">{meta}</div> : null}
        </div>
        {actions ? (
          <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
        ) : null}
      </div>
    </div>
  );
}

/** Secondary heading for sections inside a page (cards, tabs). */
export function SectionHeader({
  title,
  description,
  actions,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('mb-3 flex flex-wrap items-end justify-between gap-2', className)}>
      <div className="space-y-0.5">
        <h2 className="font-heading text-base font-semibold tracking-tight">{title}</h2>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}
