import type {
  ChannelAutodownload,
  ChannelRetention,
  ChannelRetentionPreview,
  ChannelCatalogStatus,
  ChannelFeedPage,
  ChannelStat,
  FollowedChannel,
  FollowList,
  LiveList,
  ChannelLive,
  UnfollowResult,
  RetentionLimits,
} from "../types";
import type { ApiResponse } from "./typed";
import { type ReadOptions, request } from "./client";

export interface ChannelQuery {
  sort?: string;
  order?: string;
  signal?: AbortSignal;
}

export interface ChannelFeedQuery {
  channel?: string;
  url?: string;
  offset?: number;
  limit?: number;
  /** When true, fetch/merge from YouTube (slower). Default prefers local catalog. */
  live?: boolean;
  /** The channel tab: uploads (default) or past and current live streams. */
  tab?: ChannelTab;
}

export type ChannelTab = "videos" | "streams";

export const channelsApi = {
  listChannels(params: ChannelQuery = {}): Promise<ChannelStat[]> {
    const { signal, ...query } = params;
    const qs = new URLSearchParams();
    Object.entries(query).forEach(([k, v]) => {
      if (v) qs.set(k, String(v));
    });
    const text = qs.toString();
    return request<ChannelStat[]>(
      `/api/channels${text ? `?${text}` : ""}`,
      signal ? { signal } : undefined
    );
  },

  searchChannels(
    q: string,
    limit = 8
  ): Promise<ApiResponse<"/api/channels/search", "get">> {
    const qs = new URLSearchParams({
      q,
      limit: String(limit),
    });
    return request(`/api/channels/search?${qs.toString()}`);
  },

  getChannelFeed(params: ChannelFeedQuery = {}): Promise<ChannelFeedPage> {
    const qs = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
    });
    const query = qs.toString();
    return request<ChannelFeedPage>(
      `/api/channels/feed${query ? `?${query}` : ""}`
    );
  },

  searchChannelCatalog(params: {
    q: string;
    channel?: string;
    url?: string;
    limit?: number;
    semantic?: boolean;
    signal?: AbortSignal;
  }): Promise<ChannelFeedPage> {
    const qs = new URLSearchParams();
    qs.set("q", params.q);
    if (params.channel) qs.set("channel", params.channel);
    if (params.url) qs.set("url", params.url);
    if (params.limit != null) qs.set("limit", String(params.limit));
    if (params.semantic === false) qs.set("semantic", "false");
    return request<ChannelFeedPage>(
      `/api/channels/catalog/search?${qs.toString()}`,
      params.signal ? { signal: params.signal } : undefined
    );
  },

  getChannelCatalogStatus(opts?: ReadOptions): Promise<ChannelCatalogStatus> {
    return request<ChannelCatalogStatus>("/api/channels/catalog/status", opts);
  },

  searchChannelYoutube(params: {
    q: string;
    channel?: string;
    url?: string;
    limit?: number;
    signal?: AbortSignal;
  }): Promise<ChannelFeedPage> {
    const qs = new URLSearchParams();
    qs.set("q", params.q);
    if (params.channel) qs.set("channel", params.channel);
    if (params.url) qs.set("url", params.url);
    if (params.limit != null) qs.set("limit", String(params.limit));
    return request<ChannelFeedPage>(
      `/api/channels/youtube-search?${qs.toString()}`,
      params.signal ? { signal: params.signal } : undefined
    );
  },

  searchYoutubeVideos(params: {
    q: string;
    limit?: number;
    offset?: number;
    signal?: AbortSignal;
  }): Promise<ChannelFeedPage> {
    const qs = new URLSearchParams();
    qs.set("q", params.q);
    if (params.limit != null) qs.set("limit", String(params.limit));
    if (params.offset != null) qs.set("offset", String(params.offset));
    return request<ChannelFeedPage>(
      `/api/youtube/search?${qs.toString()}`,
      params.signal ? { signal: params.signal } : undefined
    );
  },

  updateChannelYoutubeSearch(params: {
    channel?: string;
    url?: string;
    direct_youtube_search: boolean | null;
  }): Promise<ApiResponse<"/api/channels/catalog/youtube-search", "patch">> {
    return request("/api/channels/catalog/youtube-search", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channel: params.channel ?? null,
        url: params.url ?? null,
        direct_youtube_search: params.direct_youtube_search,
      }),
    });
  },

  indexChannelCatalog(
    params: {
      channel?: string;
      url?: string;
      force?: boolean;
      mode?: "incremental" | "full";
    } = {}
  ): Promise<ApiResponse<"/api/channels/catalog/index", "post">> {
    return request("/api/channels/catalog/index", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channel: params.channel ?? null,
        url: params.url ?? null,
        force: params.force ?? false,
        mode: params.mode ?? "incremental",
      }),
    });
  },

  getChannelAutodownload(params: {
    channel?: string;
    url?: string;
  }): Promise<ChannelAutodownload> {
    const qs = new URLSearchParams();
    if (params.channel) qs.set("channel", params.channel);
    if (params.url) qs.set("url", params.url);
    return request<ChannelAutodownload>(
      `/api/channels/autodownload?${qs.toString()}`
    );
  },

  updateChannelAutodownload(params: {
    channel?: string;
    url?: string;
    enabled: boolean;
    previous_mode: ChannelAutodownload["previous_mode"];
    previous_count?: number | null;
    quality_preset: string;
    include_completed_streams: boolean;
  }): Promise<ChannelAutodownload> {
    return request<ChannelAutodownload>("/api/channels/autodownload", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channel: params.channel ?? null,
        url: params.url ?? null,
        enabled: params.enabled,
        previous_mode: params.previous_mode,
        previous_count: params.previous_count ?? null,
        quality_preset: params.quality_preset,
        include_completed_streams: params.include_completed_streams,
      }),
    });
  },

  getChannelRetention(
    channel: string,
    opts?: ReadOptions
  ): Promise<ChannelRetention> {
    const qs = new URLSearchParams({ channel });
    return request<ChannelRetention>(
      `/api/channels/retention?${qs.toString()}`,
      opts
    );
  },

  saveChannelRetention(
    params: RetentionLimits & { channel: string; enabled: boolean }
  ): Promise<ChannelRetention> {
    return request<ChannelRetention>("/api/channels/retention", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
  },

  /** What a rule would move to the trash right now; nothing changes. */
  previewChannelRetention(
    params: RetentionLimits & { channel: string },
    opts?: ReadOptions
  ): Promise<ChannelRetentionPreview> {
    return request<ChannelRetentionPreview>("/api/channels/retention/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
      signal: opts?.signal,
    });
  },

  renameChannel(
    oldName: string,
    newName: string
  ): Promise<ApiResponse<"/api/channels", "patch">> {
    return request("/api/channels", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ old_name: oldName, new_name: newName }),
    });
  },

  listFollows(opts?: ReadOptions): Promise<FollowList> {
    return request<FollowList>("/api/follows", opts);
  },

  followChannel(
    channelUrl: string,
    channelName?: string | null
  ): Promise<FollowedChannel> {
    return request<FollowedChannel>("/api/follows", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channel_url: channelUrl,
        channel_name: channelName ?? null,
      }),
    });
  },

  unfollowChannel(channelUrl: string): Promise<UnfollowResult> {
    return request<UnfollowResult>(
      `/api/follows?channel_url=${encodeURIComponent(channelUrl)}`,
      { method: "DELETE" }
    );
  },

  getLiveNow(opts?: ReadOptions): Promise<LiveList> {
    return request<LiveList>("/api/live", opts);
  },

  getChannelLive(url: string, opts?: ReadOptions): Promise<ChannelLive> {
    return request<ChannelLive>(
      `/api/live/channel?url=${encodeURIComponent(url)}`,
      opts
    );
  },
};
