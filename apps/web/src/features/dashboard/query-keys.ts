/** Dashboard query keys (rooted at `queryKeys.dashboard.all` so notification mutations invalidate them). */
export const dashboardKeys = {
  all: ['dashboard'] as const,
  me: () => ['dashboard', 'me'] as const,
};
