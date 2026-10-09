'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Fragment } from 'react';

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { ROUTE_LABELS } from '@/config/navigation';
import { humanizeEnum } from '@/lib/enum-labels';
import { cn } from '@/lib/utils';

import { useBreadcrumbLabels } from './breadcrumb-store';

const PATTERNS = Object.entries(ROUTE_LABELS)
  .filter(([pattern]) => pattern.includes('['))
  .map(([pattern, label]) => ({
    regex: new RegExp(`^${pattern.replace(/\[[^\]]+\]/g, '[^/]+')}$`),
    label,
  }));

const ID_LIKE =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9]+|[A-Za-z0-9_-]{20,})$/i;

export interface Crumb {
  href: string;
  label: string;
}

export function buildCrumbs(pathname: string, runtime: ReadonlyMap<string, string>): Crumb[] {
  const segments = pathname.split('/').filter(Boolean);
  return segments.map((segment, index) => {
    const href = `/${segments.slice(0, index + 1).join('/')}`;
    const label =
      runtime.get(href) ??
      ROUTE_LABELS[href] ??
      PATTERNS.find((p) => p.regex.test(href))?.label ??
      (ID_LIKE.test(segment)
        ? 'Details'
        : humanizeEnum(decodeURIComponent(segment).replace(/-/g, ' ')));
    return { href, label };
  });
}

/** Automatic breadcrumbs from the URL + `ROUTE_LABELS` + runtime labels (`useBreadcrumbLabel`). */
export function AppBreadcrumbs({ className }: { className?: string }) {
  const pathname = usePathname();
  const runtime = useBreadcrumbLabels();
  const crumbs = buildCrumbs(pathname, runtime);
  if (crumbs.length === 0) return null;

  return (
    <Breadcrumb className={cn('min-w-0', className)}>
      <BreadcrumbList className="flex-nowrap">
        {crumbs.map((crumb, index) => {
          const last = index === crumbs.length - 1;
          return (
            <Fragment key={crumb.href}>
              {index > 0 ? <BreadcrumbSeparator className="hidden md:block" /> : null}
              <BreadcrumbItem className={cn(!last && 'hidden md:inline-flex', 'min-w-0')}>
                {last ? (
                  <BreadcrumbPage className="truncate font-medium">{crumb.label}</BreadcrumbPage>
                ) : (
                  <BreadcrumbLink asChild>
                    <Link href={crumb.href} className="truncate">
                      {crumb.label}
                    </Link>
                  </BreadcrumbLink>
                )}
              </BreadcrumbItem>
            </Fragment>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
