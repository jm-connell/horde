import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { ApiError } from "../api/client";
import { describeError } from "../apiErrors";
import { useAuth } from "../context/AuthContext";
import { useToast } from "../context/ToastContext";
import { appSettingsQuery } from "./app";
import { isYoutubeChannelUrl, normalizeChannelUrl } from "../utils/followUrl";
import type {
  ChannelFeedEntry,
  FollowedChannel,
  LiveChannel,
  Subscription,
} from "../types";
import { queryKeys } from "./keys";

const NO_FOLLOWS: FollowedChannel[] = [];
const NO_LIVE: LiveChannel[] = [];
const NO_SUBSCRIPTIONS: Subscription[] = [];

/** Channels the signed-in user follows. */
export function useFollows(enabled = true) {
  const query = useQuery({
    queryKey: queryKeys.follows.list,
    queryFn: ({ signal }) => api.listFollows({ signal }),
    enabled,
  });
  return { ...query, follows: query.data?.items ?? NO_FOLLOWS };
}

/** The Subscriptions page: follows, automatic downloads and cleanup rules. */
export function useSubscriptions() {
  const query = useQuery({
    queryKey: queryKeys.follows.subscriptions,
    queryFn: ({ signal }) => api.listSubscriptions({ signal }),
  });
  return { ...query, items: query.data?.items ?? NO_SUBSCRIPTIONS };
}

function useInvalidateFollows() {
  const queryClient = useQueryClient();
  return () => {
    // Live cards ride on the Recommended page loaded ahead.
    queryClient.removeQueries({ queryKey: queryKeys.discover.firstPage });
    return Promise.all([
      // "follows" also covers the Subscriptions page.
      queryClient.invalidateQueries({ queryKey: ["follows"] }),
      queryClient.invalidateQueries({ queryKey: queryKeys.live.now }),
    ]);
  };
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

/** Hide (or show again) a followed channel's live streams. */
export function useHideLiveMutation() {
  const invalidate = useInvalidateFollows();
  return useMutation({
    mutationFn: ({ url, hide }: { url: string; hide: boolean }) =>
      api.setFollowHideLive(url, hide),
    onSuccess: invalidate,
  });
}

/**
 * Follow state of one channel page and a toggle for it. `followable` is false
 * when the channel has no YouTube URL (nothing to follow).
 */
export function useChannelFollow(
  channelUrl: string | null,
  channelName: string | null
) {
  const followable = isYoutubeChannelUrl(channelUrl);
  const { follows } = useFollows(followable);
  const { showError } = useToast();
  const { subscribe, pending: subscribing } = useSubscribe();
  const unfollow = useUnfollowMutation();
  const hideLive = useHideLiveMutation();
  const normalized = channelUrl ? normalizeChannelUrl(channelUrl) : null;
  const row = normalized
    ? follows.find((f) => f.channel_url === normalized)
    : undefined;
  const followed = !!row;
  const toggle = () => {
    if (!channelUrl) return;
    if (followed && normalized) unfollow.mutate(normalized);
    else
      subscribe(channelUrl, channelName).catch((err: unknown) =>
        showError(`Could not subscribe: ${describeError(err)}`)
      );
  };
  return {
    followable,
    followed,
    /** Its live streams are hidden (it stays followed). */
    liveHidden: !!row?.hide_live,
    setLiveHidden: (hide: boolean) =>
      normalized && hideLive.mutate({ url: normalized, hide }),
    pending: subscribing || unfollow.isPending || hideLive.isPending,
    toggle,
  };
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

/** What a YouTube channel's page says: its picture and short bio (null when unknown). */
export function useChannelPage(url: string | null) {
  const query = useQuery({
    queryKey: queryKeys.channels.avatar(url ?? ""),
    queryFn: ({ signal }) => api.getChannelAvatar(url ?? "", { signal }),
    enabled: Boolean(url),
    staleTime: Infinity,
  });
  return { avatar: query.data?.url ?? null, about: query.data?.about ?? null };
}

/** A YouTube channel's profile picture URL (null when it has none or is not known). */
export function useChannelAvatar(url: string | null) {
  return useChannelPage(url).avatar;
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
        youtube_watched: false,
      }
    : null;
  return { ...query, live, entry };
}

/**
 * Whether subscribing may turn Ask on for the channel, as the server decides
 * (`follows.may_index_on_subscribe`): with Manage channel indexing, or while
 * the administrator includes this account's new channels.
 */
export function useMayIndexOnSubscribe(): boolean {
  const { can, isAdmin } = useAuth();
  const settings = useQuery(appSettingsQuery()).data;
  if (can("manage_ask")) return true;
  if (!settings || !can("manage_subscriptions")) return false;
  return (
    settings.new_channel_subscribe !== "never" &&
    (isAdmin || settings.new_channel_subscribe_members)
  );
}

/**
 * Subscribe to a channel and, where allowed, turn Ask on for it: by itself up
 * to the server's limit, while a bigger channel only gets a warning (with
 * "Index anyway" for those who manage Ask).
 */
export function useSubscribe() {
  const { can } = useAuth();
  const { showToast, showError } = useToast();
  const queryClient = useQueryClient();
  const follow = useFollowMutation();
  const mayIndex = useMayIndexOnSubscribe();

  const indexFor = async (
    channelUrl: string,
    name: string,
    confirmLarge = false
  ) => {
    try {
      const done = await api.indexSubscribedChannel(channelUrl, confirmLarge);
      // YouTube's name for it, when the subscription had none yet.
      const shown = done.channel_name ?? name;
      void queryClient.invalidateQueries({ queryKey: queryKeys.ask.channels });
      void queryClient.invalidateQueries({ queryKey: ["follows"] });
      if (done.large) {
        const count = done.video_count;
        showToast(
          `${shown} has ${
            count == null ? "more than 500" : count.toLocaleString()
          } videos, so it was not indexed for Ask and search: fetching every caption takes hours.`,
          {
            key: `ask-index-${channelUrl}`,
            persistent: true,
            action: can("manage_ask")
              ? {
                  label: "Index anyway",
                  onClick: () => void indexFor(channelUrl, shown, true),
                }
              : undefined,
          }
        );
      } else if (done.indexed && !done.already) {
        showToast(`Indexing ${shown} for Ask and search`);
      }
    } catch (err) {
      // No full-text search here, or a link Ask cannot read as a channel:
      // the subscription stands and there is nothing to turn on.
      if (
        err instanceof ApiError &&
        (err.code === "unavailable" || err.code === "invalid_channel")
      )
        return;
      showError(`Could not turn Ask on for ${name}: ${describeError(err)}`);
    }
  };

  const subscribe = async (
    url: string,
    name?: string | null,
    { indexAsk = true }: { indexAsk?: boolean } = {}
  ): Promise<FollowedChannel> => {
    const followed = await follow.mutateAsync({ url, name });
    const shown = followed.channel_name ?? name ?? followed.channel_url;
    if (indexAsk && mayIndex) void indexFor(followed.channel_url, shown);
    return followed;
  };

  return { subscribe, pending: follow.isPending, mayIndex };
}
