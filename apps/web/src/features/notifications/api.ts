'use client';

/**
 * Notification queries and mutations (`/users/me/notifications`). The unread count is polled while
 * the tab is visible so the top-bar bell stays current without a websocket.
 */
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type {
  NotificationDto,
  NotificationReadAllResultDto,
  NotificationUnreadCountDto,
} from '@app/shared';

import { api, getErrorMessage } from '@/lib/api-client';
import { queryKeys } from '@/lib/query-keys';

export const NOTIFICATIONS_PATH = '/users/me/notifications';
/** Bell polling interval (paused while the tab is hidden). */
export const UNREAD_POLL_MS = 60_000;

export function unreadCountQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.notifications.unreadCount(),
    queryFn: ({ signal }) =>
      api.get<NotificationUnreadCountDto>(`${NOTIFICATIONS_PATH}/unread-count`, { signal }),
    staleTime: 30_000,
    refetchInterval: UNREAD_POLL_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });
}

export function useUnreadNotificationCount({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({ ...unreadCountQueryOptions(), enabled });
}

/** The latest few notifications (bell popover). */
export function useLatestNotifications({ limit = 8, enabled = true } = {}) {
  return useQuery({
    queryKey: queryKeys.notifications.list({ latest: true, limit }),
    queryFn: ({ signal }) =>
      api.getPage<NotificationDto>(NOTIFICATIONS_PATH, { query: { limit }, signal }),
    enabled,
    staleTime: 15_000,
  });
}

function useInvalidateNotifications() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.notifications.all }),
      queryClient.invalidateQueries({ queryKey: queryKeys.dashboard.all }),
    ]);
}

export function useMarkNotificationRead() {
  const invalidate = useInvalidateNotifications();
  return useMutation({
    mutationFn: (id: string) => api.post<NotificationDto>(`${NOTIFICATIONS_PATH}/${id}/read`),
    onSuccess: () => invalidate(),
    onError: (error) =>
      toast.error("Couldn't update the notification", { description: getErrorMessage(error) }),
  });
}

export function useMarkAllNotificationsRead() {
  const invalidate = useInvalidateNotifications();
  return useMutation({
    mutationFn: () => api.post<NotificationReadAllResultDto>(`${NOTIFICATIONS_PATH}/read-all`),
    onSuccess: async (result) => {
      await invalidate();
      if (result.updated > 0) {
        toast.success(
          result.updated === 1
            ? '1 notification marked as read'
            : `${result.updated} notifications marked as read`,
        );
      }
    },
    onError: (error) =>
      toast.error("Couldn't mark notifications as read", { description: getErrorMessage(error) }),
  });
}
