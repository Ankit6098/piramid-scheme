'use client';

import { ArrowLeftRight, ShieldCheck, UserRound } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Suspense } from 'react';

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from '@/components/ui/sidebar';
import { Skeleton } from '@/components/ui/skeleton';
import {
  filterNav,
  isNavItemActive,
  navForArea,
  type AppArea,
  type NavGroup,
} from '@/config/navigation';
import { routes } from '@/config/routes';
import { useSession } from '@/hooks/use-session';

import { BrandMark } from './brand-mark';

/** Collapsible app sidebar: icon rail on desktop, Sheet drawer on mobile. */
export function AppSidebar({ area }: { area: AppArea }) {
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="h-14 justify-center border-b border-sidebar-border px-3">
        <SidebarBrand area={area} />
      </SidebarHeader>
      <SidebarContent>
        <nav
          aria-label={area === 'admin' ? 'Admin navigation' : 'Main navigation'}
          className="contents"
        >
          <Suspense fallback={<NavFallback area={area} />}>
            <SidebarNav area={area} />
          </Suspense>
        </nav>
      </SidebarContent>
      <SidebarFooter className="border-t border-sidebar-border">
        <Suspense fallback={null}>
          <AreaSwitch area={area} />
        </Suspense>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

function SidebarBrand({ area }: { area: AppArea }) {
  const home = area === 'admin' ? routes.admin.overview : routes.member.dashboard;
  return (
    <Link
      href={home}
      className="flex min-w-0 items-center gap-2 rounded-md outline-none group-data-[collapsible=icon]:justify-center"
      aria-label={area === 'admin' ? 'Admin console home' : 'Dashboard'}
    >
      <BrandMark className="group-data-[collapsible=icon]:[&>span:last-child]:hidden" />
      {area === 'admin' ? (
        <span className="ml-auto rounded-md bg-primary/10 px-1.5 py-0.5 text-[0.65rem] font-semibold tracking-wide text-primary uppercase group-data-[collapsible=icon]:hidden">
          Admin
        </span>
      ) : null}
    </Link>
  );
}

function NavGroups({ groups, pathname }: { groups: readonly NavGroup[]; pathname: string | null }) {
  const { isMobile, setOpenMobile } = useSidebar();
  return (
    <>
      {groups.map((group) => (
        <SidebarGroup key={group.label}>
          <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {group.items.map((item) => {
                const active = pathname ? isNavItemActive(item, pathname) : false;
                return (
                  <SidebarMenuItem key={item.href}>
                    <SidebarMenuButton asChild isActive={active} tooltip={item.title}>
                      <Link
                        href={item.href}
                        aria-current={active ? 'page' : undefined}
                        onClick={() => {
                          if (isMobile) setOpenMobile(false);
                        }}
                      >
                        <item.icon aria-hidden />
                        <span>{item.title}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      ))}
    </>
  );
}

function SidebarNav({ area }: { area: AppArea }) {
  const pathname = usePathname();
  const { user, status } = useSession();
  const groups = navForArea(area);

  if (area === 'admin') {
    if (status === 'loading') return <NavFallback area="admin" />;
    return <NavGroups groups={filterNav(groups, user?.permissions ?? [])} pathname={pathname} />;
  }
  return <NavGroups groups={groups} pathname={pathname} />;
}

/** Static fallback while the pathname/session resolve (no random widths — prerender-safe). */
function NavFallback({ area }: { area: AppArea }) {
  if (area === 'member') return <NavGroups groups={navForArea('member')} pathname={null} />;
  const widths = ['w-24', 'w-28', 'w-20', 'w-32', 'w-24', 'w-28'];
  return (
    <SidebarGroup aria-hidden>
      <SidebarMenu>
        {widths.map((width, index) => (
          <SidebarMenuItem key={index}>
            <div className="flex h-8 items-center gap-2 px-2">
              <Skeleton className="size-4 rounded-md" />
              <Skeleton className={`h-3.5 ${width} group-data-[collapsible=icon]:hidden`} />
            </div>
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
    </SidebarGroup>
  );
}

/** Switch between the member area and the admin console (admins only). */
function AreaSwitch({ area }: { area: AppArea }) {
  const { user } = useSession();
  if (!user?.isAdmin) return null;
  const toAdmin = area === 'member';
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton
          asChild
          tooltip={toAdmin ? 'Admin console' : 'Member area'}
          variant="outline"
        >
          <Link href={toAdmin ? routes.admin.overview : routes.member.dashboard}>
            {toAdmin ? <ShieldCheck aria-hidden /> : <UserRound aria-hidden />}
            <span>{toAdmin ? 'Admin console' : 'Member area'}</span>
            <ArrowLeftRight
              className="ml-auto size-3.5 opacity-60 group-data-[collapsible=icon]:hidden"
              aria-hidden
            />
          </Link>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
