/**
 * Central TanStack Query key factory. Every key starts with a stable root so invalidation can target
 * a whole feature (`queryClient.invalidateQueries({ queryKey: queryKeys.rewards.all })`).
 *
 * Slices: add your feature's keys here (one object per feature, `all` first, then narrower keys
 * built on top of it). Keep params objects serializable; pass the same object shape everywhere.
 *
 * @example
 *   rewards: {
 *     all: ["rewards"] as const,
 *     list: (params: RewardListParams) => ["rewards", "list", params] as const,
 *     detail: (id: string) => ["rewards", "detail", id] as const,
 *   },
 *
 * Roots are repeated as literals on purpose: referencing `queryKeys` inside its own initializer
 * makes TypeScript infer `any`. Feature hooks may also live next to the feature
 * (`src/features/<f>/api.ts`) as long as the key itself is defined here.
 */
export type ListParams = Record<
  string,
  string | number | boolean | null | undefined | readonly string[]
>;

export const queryKeys = {
  session: {
    all: ['session'] as const,
    current: () => ['session', 'current'] as const,
  },
  settings: {
    all: ['settings'] as const,
    public: () => ['settings', 'public'] as const,
    admin: () => ['settings', 'admin'] as const,
  },
  notifications: {
    all: ['notifications'] as const,
    list: (params: ListParams = {}) => ['notifications', 'list', params] as const,
    unreadCount: () => ['notifications', 'unread-count'] as const,
  },
  // ─── member features ───────────────────────────────────────────────────
  dashboard: {
    all: ['dashboard'] as const,
  },
  programs: {
    all: ['programs'] as const,
    list: (params: ListParams = {}) => ['programs', 'list', params] as const,
    detail: (idOrCode: string) => ['programs', 'detail', idOrCode] as const,
  },
  enrollments: {
    all: ['enrollments'] as const,
    mine: (params: ListParams = {}) => ['enrollments', 'mine', params] as const,
  },
  referrals: {
    all: ['referrals'] as const,
    code: () => ['referrals', 'code'] as const,
    team: (params: ListParams = {}) => ['referrals', 'team', params] as const,
    sponsor: () => ['referrals', 'sponsor'] as const,
  },
  rewards: {
    all: ['rewards'] as const,
    summary: () => ['rewards', 'summary'] as const,
    list: (params: ListParams = {}) => ['rewards', 'list', params] as const,
    detail: (id: string) => ['rewards', 'detail', id] as const,
  },
  profile: {
    all: ['profile'] as const,
  },
  // ─── admin features ────────────────────────────────────────────────────
  admin: {
    all: ['admin'] as const,
    overview: () => ['admin', 'overview'] as const,
    offerings: (params: ListParams = {}) => ['admin', 'offerings', params] as const,
    offering: (id: string) => ['admin', 'offering', id] as const,
    programs: (params: ListParams = {}) => ['admin', 'programs', params] as const,
    program: (id: string) => ['admin', 'program', id] as const,
    policies: (programId: string) => ['admin', 'policies', programId] as const,
    enrollments: (params: ListParams = {}) => ['admin', 'enrollments', params] as const,
    members: (params: ListParams = {}) => ['admin', 'members', params] as const,
    member: (id: string) => ['admin', 'member', id] as const,
    events: (params: ListParams = {}) => ['admin', 'events', params] as const,
    event: (id: string) => ['admin', 'event', id] as const,
    rewards: (params: ListParams = {}) => ['admin', 'rewards', params] as const,
    reward: (id: string) => ['admin', 'reward', id] as const,
    ledger: (params: ListParams = {}) => ['admin', 'ledger', params] as const,
    reconciliation: (params: ListParams = {}) => ['admin', 'reconciliation', params] as const,
    flags: (params: ListParams = {}) => ['admin', 'flags', params] as const,
    audit: (params: ListParams = {}) => ['admin', 'audit', params] as const,
  },
} as const;
