import type {
  DiscoverFeed,
  DiscoverRefresh,
  DiscoverStatus,
  RecFeedback,
  RecFeedbackKind,
  RecFeedbackList,
  StreamWatch,
  StreamWatchWrite,
  SuggestedChannels,
} from "../types";
import { unlockedAccountId } from "../offline/unlock";
import { type ReadOptions, request } from "./client";

/** Recommended+: the feed, channels to follow, feedback and stream history. */
export const discoverApi = {
  getDiscoverFeed(
    params: { cursor?: string | null; limit?: number; seed?: number },
    opts?: ReadOptions
  ): Promise<DiscoverFeed> {
    const q = new URLSearchParams();
    if (params.cursor) q.set("cursor", params.cursor);
    if (params.limit) q.set("limit", String(params.limit));
    if (params.seed != null) q.set("seed", String(params.seed));
    return request<DiscoverFeed>(`/api/discover/feed?${q.toString()}`, opts);
  },

  getDiscoverStatus(opts?: ReadOptions): Promise<DiscoverStatus> {
    return request<DiscoverStatus>("/api/discover/status", opts);
  },

  getSuggestedChannels(
    seed?: number,
    opts?: ReadOptions
  ): Promise<SuggestedChannels> {
    const q = seed != null ? `?seed=${seed}` : "";
    return request<SuggestedChannels>(`/api/discover/channels${q}`, opts);
  },

  refreshDiscover(): Promise<DiscoverRefresh> {
    return request<DiscoverRefresh>("/api/discover/refresh", {
      method: "POST",
    });
  },

  listRecFeedback(opts?: ReadOptions): Promise<RecFeedbackList> {
    return request<RecFeedbackList>("/api/discover/feedback", opts);
  },

  addRecFeedback(
    kind: RecFeedbackKind,
    key: string,
    label?: string | null
  ): Promise<RecFeedback> {
    return request<RecFeedback>("/api/discover/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, key, label: label ?? null }),
    });
  },

  removeRecFeedback(id: number): Promise<RecFeedback> {
    return request<RecFeedback>(`/api/discover/feedback/${id}`, {
      method: "DELETE",
    });
  },

  /** Null when not sent: acting as an account unlocked on this device. */
  async recordStreamWatch(
    payload: StreamWatchWrite
  ): Promise<StreamWatch | null> {
    // The session cookie may be somebody else's (see saveProgress).
    if (unlockedAccountId() !== null) return null;
    return request<StreamWatch>("/api/discover/history", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      // Sent as the page is hidden or closed too: let it outlive the page.
      keepalive: true,
    });
  },
};
