import type { FieldPath, FieldValues, UseFormSetError } from 'react-hook-form';

import { isApiError } from '@/lib/api-client';

/**
 * What `applyApiFieldErrors` writes to: the `form` returned by `useForm()` (preferred — paths that
 * are not registered inputs are detected and left to the caller's toast/alert) or a bare
 * `form.setError` (then only `knownFields` can be applied).
 */
export type ApiErrorFormTarget<T extends FieldValues> =
  | UseFormSetError<T>
  | {
      setError: UseFormSetError<T>;
      /** `form.control`; only its set of registered field names is read. */
      control: { _names: { mount: ReadonlySet<string> } };
    };

/**
 * Copies `ApiError.fieldErrors` (server-side validation issues) onto react-hook-form fields.
 *
 * A path counts only when it is a field the form renders: listed in `knownFields` (custom controls
 * that display `formState.errors` themselves) or registered with the form (pass `form`, not
 * `form.setError`). Anything else — a 409 whose details are not field issues, an issue about a field
 * the form doesn't show — is not applied, and the function returns false so the caller shows a
 * toast/alert instead of failing silently.
 *
 * Returns true when at least one field error was applied.
 *
 * @example
 *   onError: (error) => {
 *     if (!applyApiFieldErrors(error, form)) toast.error(getErrorMessage(error));
 *   }
 */
export function applyApiFieldErrors<T extends FieldValues>(
  error: unknown,
  target: ApiErrorFormTarget<T>,
  options: { knownFields?: readonly FieldPath<T>[] } = {},
): boolean {
  if (!isApiError(error) || !error.hasFieldErrors) return false;
  const setError = typeof target === 'function' ? target : target.setError;
  const registered = typeof target === 'function' ? null : target.control._names.mount;
  const known = new Set<string>(options.knownFields ?? []);
  let applied = false;
  for (const [path, message] of Object.entries(error.fieldErrors)) {
    if (!known.has(path) && !registered?.has(path)) continue;
    setError(path as FieldPath<T>, { type: 'server', message }, { shouldFocus: !applied });
    applied = true;
  }
  return applied;
}
