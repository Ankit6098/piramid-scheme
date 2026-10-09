'use client';

import { LogOut, Monitor, Moon, Search, Sun } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTheme } from 'next-themes';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command';
import { Kbd, KbdGroup } from '@/components/ui/kbd';
import { adminNav, filterNav, memberNav, type NavGroup } from '@/config/navigation';
import { useLogout, useSession } from '@/hooks/use-session';

/**
 * Global ⌘K / Ctrl+K command palette: jump to any page the user may open, switch theme, sign out.
 * (Global search placeholder — slices can add result groups here later.)
 */
export function CommandMenu() {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const { setTheme } = useTheme();
  const { user } = useSession();
  const logout = useLogout();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setOpen((value) => !value);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const groups: { heading: string; groups: NavGroup[] }[] = [
    { heading: 'Member', groups: [...memberNav] },
  ];
  if (user?.isAdmin)
    groups.push({ heading: 'Admin', groups: filterNav(adminNav, user.permissions) });

  const run = (action: () => void) => {
    setOpen(false);
    action();
  };

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        className="h-8 w-8 justify-center gap-2 px-0 text-muted-foreground sm:w-56 sm:justify-start sm:px-2.5 lg:w-64"
        aria-label="Search pages and actions"
        aria-keyshortcuts="Control+K Meta+K"
      >
        <Search aria-hidden />
        <span className="hidden flex-1 text-left font-normal sm:inline">Search…</span>
        <KbdGroup className="hidden sm:inline-flex">
          <Kbd>Ctrl</Kbd>
          <Kbd>K</Kbd>
        </KbdGroup>
      </Button>
      <CommandDialog
        open={open}
        onOpenChange={setOpen}
        title="Search"
        description="Jump to a page or run an action"
      >
        <Command>
          <CommandInput placeholder="Search pages and actions…" />
          <CommandList>
            <CommandEmpty>No matches.</CommandEmpty>
            {groups.flatMap(({ heading, groups: navGroups }) =>
              navGroups.map((group) => (
                <CommandGroup
                  key={`${heading}-${group.label}`}
                  heading={groups.length > 1 ? `${heading} · ${group.label}` : group.label}
                >
                  {group.items.map((item) => (
                    <CommandItem
                      key={item.href}
                      value={`${heading} ${item.title} ${item.href}`}
                      keywords={[...(item.keywords ?? []), item.description ?? '']}
                      onSelect={() => run(() => router.push(item.href))}
                    >
                      <item.icon aria-hidden />
                      <span>{item.title}</span>
                      {item.description ? (
                        <span className="ml-2 hidden truncate text-xs text-muted-foreground sm:inline">
                          {item.description}
                        </span>
                      ) : null}
                    </CommandItem>
                  ))}
                </CommandGroup>
              )),
            )}
            <CommandSeparator />
            <CommandGroup heading="Preferences">
              <CommandItem value="theme light" onSelect={() => run(() => setTheme('light'))}>
                <Sun aria-hidden />
                Light theme
              </CommandItem>
              <CommandItem value="theme dark" onSelect={() => run(() => setTheme('dark'))}>
                <Moon aria-hidden />
                Dark theme
              </CommandItem>
              <CommandItem value="theme system" onSelect={() => run(() => setTheme('system'))}>
                <Monitor aria-hidden />
                System theme
              </CommandItem>
              {user ? (
                <CommandItem value="sign out log out" onSelect={() => run(() => logout.mutate())}>
                  <LogOut aria-hidden />
                  Sign out
                </CommandItem>
              ) : null}
            </CommandGroup>
          </CommandList>
        </Command>
      </CommandDialog>
    </>
  );
}
