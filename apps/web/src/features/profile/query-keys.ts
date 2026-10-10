/** Query keys of the profile feature (root shared with `queryKeys.profile.all`). */
export const profileKeys = {
  all: ['profile'] as const,
  me: () => ['profile', 'me'] as const,
  sessions: () => ['profile', 'sessions'] as const,
  activity: () => ['profile', 'activity'] as const,
};
