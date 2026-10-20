import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type { ChannelFeedEntry, FollowedChannel, LiveChannel } from "../types";
import { queryKeys } from "./keys";

const NO_FOLLOWS: FollowedChannel[] = [];
const NO_LIVE: LiveChannel[] = [];

/** Channels the signed-in user follows. */
export function useFollows(enabled = true) {
  const query = useQuery({
    queryKey: queryKeys.follows.list,
    queryFn: ({ signal }) => api.listFollows({ signal }),
    enabled,
  });
  return { ...query, follows: query.data?.items ?? NO_FOLLOWS };
}

function useInvalidateFollows() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.follows.list }),
      queryClient.invalidateQueries({ queryKey: queryKeys.live.now }),
    ]);
}

export function useFollowMutation() {
  const invalidate = useInvalidateFollows();
  return useMutation({
    mutationFn: ({ url, name }: { url: string; name?: string | null }) =>
      api.followChannel(url, name),
    onSuccess: invalidate,
  });
}

export function useUnfollowMutation() {
  const invalidate = useInvalidateFollows();
  return useMutation({
    mutationFn: (url: string) => api.unfollowChannel(url),
    onSuccess: invalidate,
  });
}

/**
 * Followed channels that are live. Polls every minute while the tab is
 * visible; with `enabled: false` nothing is fetched at all.
 */
export function useLiveNow({ enabled }: { enabled: boolean }) {
  const query = useQuery({
    queryKey: queryKeys.live.now,
    queryFn: ({ signal }) => api.getLiveNow({ signal }),
    enabled,
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });
  return { ...query, live: query.data?.items ?? NO_LIVE };
}

/**
 * The broadcast a channel is live with right now, as a feed entry (null when
 * it is not live). Re-checked every two minutes while the page is open.
 */
export function useChannelLive(url: string | null) {
  const query = useQuery({
    queryKey: queryKeys.live.channel(url ?? ""),
    queryFn: ({ signal }) => api.getChannelLive(url ?? "", { signal }),
    enabled: Boolean(url),
    staleTime: 60_000,
    refetchInterval: 120_000,
    refetchIntervalInBackground: false,
  });
  const live = query.data?.live ?? null;
  const entry: ChannelFeedEntry | null = live
    ? {
        id: live.video_id,
        url: live.watch_url,
        title: live.title ?? null,
        thumbnail_url: live.thumbnail_url,
        view_count: null,
        in_library: false,
        live_status: "is_live",
      }
    : null;
  return { ...query, live, entry };
}
