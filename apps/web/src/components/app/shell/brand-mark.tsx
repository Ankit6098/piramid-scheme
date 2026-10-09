import { siteConfig } from '@/config/site';
import { cn } from '@/lib/utils';

/** Logo glyph: a rounded tile with an upward "growth through sharing" chevron. Decorative. */
export function BrandGlyph({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground',
        className,
      )}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        className="size-[60%]"
        strokeWidth={2.25}
        stroke="currentColor"
      >
        <path d="M5 15.5 12 8.5l7 7" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M8.5 19h7" strokeLinecap="round" />
      </svg>
    </span>
  );
}

/** Glyph + product name. */
export function BrandMark({ className, compact }: { className?: string; compact?: boolean }) {
  return (
    <span className={cn('flex min-w-0 items-center gap-2.5', className)}>
      <BrandGlyph />
      {compact ? (
        <span className="sr-only">{siteConfig.name}</span>
      ) : (
        <span className="truncate font-heading text-[0.95rem] font-semibold tracking-tight">
          {siteConfig.name}
        </span>
      )}
    </span>
  );
}
