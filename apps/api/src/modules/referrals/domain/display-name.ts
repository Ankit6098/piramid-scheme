import type { MemberStatusBucket, UserStatus } from '@app/shared';

/**
 * Privacy-filtered name shown to other members (business rules §6): first name + last initial,
 * e.g. "Anita Kumari Sharma" → "Anita S.". A single-word name is shown as is.
 *
 * `TEAM_DISPLAY_NAME_SQL` mirrors this rule in SQL (search filters on the display name so it never
 * matches hidden parts of a name).
 */
export function toDisplayName(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  const first = parts[0];
  if (!first) return 'Member';
  if (parts.length === 1) return first;
  const last = parts[parts.length - 1] ?? '';
  const initial = Array.from(last)[0]?.toUpperCase() ?? '';
  return `${first} ${initial}.`;
}

/** Coarse account state other members may see. */
export function statusBucketOf(status: UserStatus): MemberStatusBucket {
  return status === 'ACTIVE' ? 'ACTIVE' : 'INACTIVE';
}

/** Escapes `%`, `_` and `\` for a LIKE/ILIKE pattern used with `ESCAPE '\'`. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export interface NameSearchPatterns {
  /** `%query%` matched against the display name (or the full name for admins). */
  pattern: string;
  /**
   * `%token%` for the longest query token of ≥ 3 characters — a cheap, trigram-indexed prefilter on
   * `users.full_name` (a display-name token of that length is always part of the first name). Null
   * when the query has no such token.
   */
  prefilter: string | null;
}

/** Builds the ILIKE patterns for a name search (whitespace collapsed, wildcards escaped). */
export function nameSearchPatterns(query: string): NameSearchPatterns {
  const normalized = query.trim().replace(/\s+/g, ' ');
  const longest = normalized
    .split(' ')
    .filter((t) => t.length >= 3 && !t.includes('.'))
    .sort((a, b) => b.length - a.length)[0];
  return {
    pattern: `%${escapeLike(normalized)}%`,
    prefilter: longest ? `%${escapeLike(longest)}%` : null,
  };
}
