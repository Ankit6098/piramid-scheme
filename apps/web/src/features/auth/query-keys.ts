/** Query keys owned by the auth feature (the session itself lives under `queryKeys.session`). */
export const authKeys = {
  all: ['auth'] as const,
  referralPreview: (code: string) => ['auth', 'referral-preview', code] as const,
};
