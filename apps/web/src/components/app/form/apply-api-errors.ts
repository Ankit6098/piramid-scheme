import type { FieldPath, FieldValues, UseFormSetError } from 'react-hook-form';

import { isApiError } from '@/lib/api-client';

/**
 * Copies `ApiError.fieldErrors` (server-side Zod validation) onto react-hook-form fields.
 * Returns true when at least one field error was applied — otherwise show a toast/alert.
 *
 * @example
 *   onError: (error) => {
 *     if (!applyApiFieldErrors(error, form.setError)) toast.error(getErrorMessage(error));
 *   }
 */
export function applyApiFieldErrors<T extends FieldValues>(
  error: unknown,
  setError: UseFormSetError<T>,
  options: { knownFields?: readonly FieldPath<T>[] } = {},
): boolean {
  if (!isApiError(error) || !error.hasFieldErrors) return false;
  let applied = false;
  let first = true;
  for (const [path, message] of Object.entries(error.fieldErrors)) {
    if (options.knownFields && !options.knownFields.includes(path as FieldPath<T>)) continue;
    setError(path as FieldPath<T>, { type: 'server', message }, { shouldFocus: first });
    first = false;
    applied = true;
  }
  return applied;
}
