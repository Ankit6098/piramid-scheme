'use client';

import { Bell, ChevronsUpDown, LogOut, Palette, ShieldCheck, UserRound } from 'lucide-react';
import Link from 'next/link';
import { useTheme } from 'next-themes';

import { UserAvatar } from '@/components/app/user-avatar';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { type AppArea } from '@/config/navigation';
import { routes } from '@/config/routes';
import { useLogout, useSession } from '@/hooks/use-session';

import { THEME_OPTIONS } from './theme-toggle';

/** Avatar dropdown: profile, notifications, area switch, theme, sign out. */
export function AccountMenu({ area }: { area: AppArea }) {
  const { user, status } = useSession();
  const { theme, setTheme } = useTheme();
  const logout = useLogout();

  if (status === 'loading' || !user) {
    return <Skeleton className="size-8 rounded-full" aria-label="Loading account" />;
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className="h-9 gap-2 px-1.5"
          aria-label={`Account menu for ${user.fullName}`}
        >
          <UserAvatar name={user.fullName} src={user.avatarUrl} size="sm" />
          <span className="hidden max-w-36 truncate text-sm font-medium lg:inline">
            {user.fullName}
          </span>
          <ChevronsUpDown className="hidden size-3.5 text-muted-foreground lg:block" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="flex items-center gap-2.5 py-2 font-normal">
          <UserAvatar name={user.fullName} src={user.avatarUrl} />
          <span className="grid min-w-0 leading-tight">
            <span className="truncate text-sm font-medium text-foreground">{user.fullName}</span>
            <span className="truncate text-xs text-muted-foreground">{user.email}</span>
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem asChild>
            <Link href={routes.member.profile}>
              <UserRound aria-hidden />
              Profile
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href={routes.member.notifications}>
              <Bell aria-hidden />
              Notifications
            </Link>
          </DropdownMenuItem>
          {user.isAdmin ? (
            <DropdownMenuItem asChild>
              <Link href={area === 'admin' ? routes.member.dashboard : routes.admin.overview}>
                {area === 'admin' ? <UserRound aria-hidden /> : <ShieldCheck aria-hidden />}
                {area === 'admin' ? 'Member area' : 'Admin console'}
              </Link>
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Palette aria-hidden />
            Theme
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-36">
            <DropdownMenuRadioGroup value={theme ?? 'system'} onValueChange={setTheme}>
              {THEME_OPTIONS.map((option) => (
                <DropdownMenuRadioItem key={option.value} value={option.value}>
                  <option.icon aria-hidden />
                  {option.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          disabled={logout.isPending}
          onSelect={(event) => {
            event.preventDefault();
            logout.mutate();
          }}
        >
          <LogOut aria-hidden />
          {logout.isPending ? 'Signing out…' : 'Sign out'}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
