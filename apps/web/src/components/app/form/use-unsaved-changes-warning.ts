'use client';

import { useEffect } from 'react';
import { useFormState, type Control, type FieldValues } from 'react-hook-form';

import type { AnyFormContext } from './form-item';

const DEFAULT_MESSAGE = 'You have unsaved changes. Leave this page and discard them?';

/**
 * Warns before the user leaves a dirty form: browser reload/close (`beforeunload`) and in-app link
 * clicks (asks for confirmation). Paused while a submit handler runs.
 *
 * The guard follows `isDirty` only — not `isSubmitSuccessful`, which react-hook-form also sets when
 * the submit handler catches a failed save. So on success the form must stop being dirty:
 * `form.reset(savedValues)` (or remount it / pass `enabled: false`) before navigating away.
 *
 * @example
 *   const form = useForm(...);
 *   useUnsavedChangesWarning(form);
 *   // on success: form.reset(toFormValues(saved));
 */
export function useUnsavedChangesWarning<T extends FieldValues, TT = T>(
  form: { control: Control<T, AnyFormContext, TT> },
  options: { enabled?: boolean; message?: string } = {},
): boolean {
  const { isDirty, isSubmitting } = useFormState({ control: form.control });
  const active = (options.enabled ?? true) && isDirty && !isSubmitting;
  const message = options.message ?? DEFAULT_MESSAGE;

  useEffect(() => {
    if (!active) return;

    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Legacy browsers need returnValue set.
      event.returnValue = '';
    };

    const onClickCapture = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }
      const anchor = (event.target as Element | null)?.closest?.('a[href]');
      if (!(anchor instanceof HTMLAnchorElement)) return;
      if (anchor.target && anchor.target !== '_self') return;
      if (anchor.hasAttribute('download')) return;
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname && url.search === window.location.search)
        return;
      if (!window.confirm(message)) {
        event.preventDefault();
        event.stopPropagation();
      }
    };

    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('click', onClickCapture, true);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('click', onClickCapture, true);
    };
  }, [active, message]);

  return active;
}
