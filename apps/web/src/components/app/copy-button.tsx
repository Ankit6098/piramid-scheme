'use client';

import { Check, Copy } from 'lucide-react';
import { useEffect, useRef, useState, type ComponentProps } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

export interface CopyButtonProps extends Omit<
  ComponentProps<typeof Button>,
  'onClick' | 'children'
> {
  /** Text placed on the clipboard. */
  value: string;
  /** What is being copied, for the accessible name and toast ("referral link"). */
  label?: string;
  /** Visible text next to the icon (icon-only when omitted). */
  children?: React.ReactNode;
  /** Show a toast on success (default true). */
  toastOnCopy?: boolean;
}

/** Copies `value` to the clipboard with visual + screen-reader feedback. */
export function CopyButton({
  value,
  label = 'value',
  children,
  toastOnCopy = true,
  variant = 'outline',
  size,
  className,
  ...props
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const timeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timeout.current), []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      clearTimeout(timeout.current);
      timeout.current = setTimeout(() => setCopied(false), 2000);
      if (toastOnCopy) toast.success(`Copied ${label} to clipboard`);
    } catch {
      toast.error(`Couldn't copy the ${label}`, {
        description: 'Select the text and copy it manually.',
      });
    }
  }

  const Icon = copied ? Check : Copy;
  const iconOnly = children === undefined;
  const accessibleName = copied ? `Copied ${label}` : `Copy ${label}`;

  const button = (
    <Button
      type="button"
      variant={variant}
      size={size ?? (iconOnly ? 'icon-sm' : 'sm')}
      onClick={copy}
      aria-label={iconOnly ? accessibleName : undefined}
      className={cn(copied && 'text-success', className)}
      {...props}
    >
      <Icon aria-hidden />
      {children}
      <span aria-live="polite" className="sr-only">
        {copied ? `Copied ${label}` : ''}
      </span>
    </Button>
  );

  if (!iconOnly) return button;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent>{accessibleName}</TooltipContent>
    </Tooltip>
  );
}
