import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type {
  NotificationTargetCreate,
  NotificationTargetUpdate,
} from "../types";
import { queryKeys } from "./keys";

/** Notification targets and the events they can subscribe to (administrators). */
export function useNotifications(enabled = true) {
  return useQuery({
    queryKey: queryKeys.notifications,
    queryFn: ({ signal }) => api.getNotifications({ signal }),
    enabled,
  });
}

function useRefresh() {
  const queryClient = useQueryClient();
  return () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.notifications });
}

export function useCreateNotificationTarget() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (body: NotificationTargetCreate) =>
      api.createNotificationTarget(body),
    onSuccess: refresh,
  });
}

export function useUpdateNotificationTarget() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: ({
      id,
      body,
    }: {
      id: string;
      body: NotificationTargetUpdate;
    }) => api.updateNotificationTarget(id, body),
    onSuccess: refresh,
  });
}

export function useDeleteNotificationTarget() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (id: string) => api.deleteNotificationTarget(id),
    onSuccess: refresh,
  });
}
