'use client';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { cn } from '@/lib/utils';

export function initialsOf(name: string | null | undefined): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0]?.charAt(0) ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.charAt(0) ?? '') : '';
  return (first + last).toUpperCase();
}

export interface UserAvatarProps {
  /** Display name — used for initials and the image alt text. */
  name: string | null | undefined;
  src?: string | null;
  size?: 'sm' | 'default' | 'lg';
  className?: string;
}

/** Round avatar with an initials fallback. */
export function UserAvatar({ name, src, size = 'default', className }: UserAvatarProps) {
  return (
    <Avatar size={size} className={className}>
      {src ? <AvatarImage src={src} alt={name ?? ''} /> : null}
      <AvatarFallback className={cn('bg-primary/10 font-medium text-primary')} aria-hidden={!name}>
        {initialsOf(name)}
      </AvatarFallback>
    </Avatar>
  );
}
