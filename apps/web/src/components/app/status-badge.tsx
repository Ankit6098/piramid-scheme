import { cn } from '@/lib/utils';
import { enumMeta, type EnumKind, type EnumValueMap, type StatusTone } from '@/lib/enum-labels';

const TONE_CLASS: Record<StatusTone, string> = {
  neutral: 'bg-secondary text-secondary-foreground ring-border',
  muted: 'bg-muted text-muted-foreground ring-border',
  primary: 'bg-primary/10 text-primary ring-primary/25',
  info: 'bg-info/10 text-info ring-info/25',
  success: 'bg-success/10 text-success ring-success/25',
  warning: 'bg-warning/10 text-warning ring-warning/25',
  destructive: 'bg-destructive/10 text-destructive ring-destructive/25',
  'destructive-outline': 'bg-transparent text-destructive ring-destructive/45',
};

const DOT_TONES: ReadonlySet<StatusTone> = new Set([
  'info',
  'success',
  'warning',
  'destructive',
  'primary',
]);

export interface ToneBadgeProps {
  tone?: StatusTone;
  children: React.ReactNode;
  /** Leading status dot (on by default for colored tones). */
  dot?: boolean;
  title?: string;
  className?: string;
}

/** Low-level pill with a semantic tone (use `StatusBadge` for enum values). */
export function ToneBadge({ tone = 'neutral', children, dot, title, className }: ToneBadgeProps) {
  const showDot = dot ?? DOT_TONES.has(tone);
  return (
    <span
      data-slot="status-badge"
      data-tone={tone}
      title={title}
      className={cn(
        'inline-flex h-5 w-fit shrink-0 items-center gap-1.5 rounded-full px-2 text-xs font-medium whitespace-nowrap ring-1 ring-inset',
        TONE_CLASS[tone],
        className,
      )}
    >
      {showDot ? <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-current" /> : null}
      {children}
    </span>
  );
}

export interface StatusBadgeProps<K extends EnumKind> {
  /** Which `@app/shared` enum `value` belongs to. */
  kind: K;
  value: EnumValueMap[K] | (string & {});
  className?: string;
  /** Override the label (keeps the tone). */
  label?: string;
}

/**
 * Label + tone for any `@app/shared` enum value. The label is text, so meaning never relies on
 * color alone.
 *
 * @example <StatusBadge kind="RewardStatus" value={reward.status} />
 */
export function StatusBadge<K extends EnumKind>({
  kind,
  value,
  className,
  label,
}: StatusBadgeProps<K>) {
  const meta = enumMeta(kind, value);
  return (
    <ToneBadge tone={meta.tone} title={meta.description} className={className}>
      {label ?? meta.label}
    </ToneBadge>
  );
}
