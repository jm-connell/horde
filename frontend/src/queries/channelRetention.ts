import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useAuth } from "../context/AuthContext";
import type { RetentionLimits } from "../types";
import { queryKeys } from "./keys";

/** A channel's retention rule (all limits unset when it has none). Anyone may read it. */
export function useChannelRetention(channel: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.channels.retention(channel),
    queryFn: ({ signal }) => api.getChannelRetention(channel, { signal }),
    enabled,
  });
}

/** Save a rule; the channel list's retention summary follows. */
export function useSaveChannelRetention() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (
      params: RetentionLimits & { channel: string; enabled: boolean }
    ) => api.saveChannelRetention(params),
    onSuccess: (row) => {
      queryClient.setQueryData(queryKeys.channels.retention(row.channel), row);
      return queryClient.invalidateQueries({
        queryKey: queryKeys.channels.all,
      });
    },
  });
}

/**
 * What `limits` would move to the trash right now. Needs `delete_videos`, and
 * only runs while at least one limit is set (pass debounced limits).
 */
export function useRetentionPreview(channel: string, limits: RetentionLimits) {
  const { can } = useAuth();
  const anyLimit =
    limits.keep_latest != null ||
    limits.max_age_days != null ||
    limits.remove_watched_after_days != null;
  return useQuery({
    queryKey: queryKeys.channels.retentionPreview(channel, limits),
    queryFn: ({ signal }) =>
      api.previewChannelRetention({ channel, ...limits }, { signal }),
    enabled: anyLimit && can("delete_videos"),
    staleTime: 0,
  });
}
