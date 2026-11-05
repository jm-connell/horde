import type {
  DiscoverFeed,
  DiscoverRefresh,
  DiscoverStatus,
  RecFeedback,
  RecFeedbackKind,
  RecFeedbackList,
  RecAlgorithm,
  RecAlgorithmUpdate,
  RecAlgorithmWrite,
  RecTopic,
  RecTopicUpdate,
  RecTopicWrite,
  RecTuningState,
  RecTuningWrite,
  StreamWatch,
  StreamWatchWrite,
  SuggestedChannels,
} from "../types";
import { unlockedAccountId } from "../offline/unlock";
import { type ReadOptions, request } from "./client";

/** Recommended: the feed, channels to follow, feedback and stream history. */
export const discoverApi = {
  getDiscoverFeed(
    params: {
      cursor?: string | null;
      limit?: number;
      seed?: number;
      /** Loaded ahead of time: its videos do not count as shown. */
      prefetch?: boolean;
      /** Only the picks in this AI category. */
      category?: string;
    },
    opts?: ReadOptions
  ): Promise<DiscoverFeed> {
    const q = new URLSearchParams();
    if (params.prefetch) q.set("prefetch", "true");
    if (params.category) q.set("category", params.category);
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

  getRecTuning(opts?: ReadOptions): Promise<RecTuningState> {
    return request<RecTuningState>("/api/discover/tuning", opts);
  },

  saveRecTuning(payload: RecTuningWrite): Promise<RecTuningState> {
    return request<RecTuningState>("/api/discover/tuning", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  },

  listRecAlgorithms(opts?: ReadOptions): Promise<{ items: RecAlgorithm[] }> {
    return request<{ items: RecAlgorithm[] }>("/api/discover/algorithms", opts);
  },

  saveRecAlgorithm(payload: RecAlgorithmWrite): Promise<RecAlgorithm> {
    return request<RecAlgorithm>("/api/discover/algorithms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  },

  updateRecAlgorithm(
    id: number,
    payload: RecAlgorithmUpdate
  ): Promise<RecAlgorithm> {
    return request<RecAlgorithm>(`/api/discover/algorithms/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  },

  deleteRecAlgorithm(id: number): Promise<RecAlgorithm> {
    return request<RecAlgorithm>(`/api/discover/algorithms/${id}`, {
      method: "DELETE",
    });
  },

  listRecTopics(opts?: ReadOptions): Promise<{ items: RecTopic[] }> {
    return request<{ items: RecTopic[] }>("/api/discover/topics", opts);
  },

  addRecTopic(payload: RecTopicWrite): Promise<RecTopic> {
    return request<RecTopic>("/api/discover/topics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  },

  updateRecTopic(id: number, payload: RecTopicUpdate): Promise<RecTopic> {
    return request<RecTopic>(`/api/discover/topics/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  },

  deleteRecTopic(id: number): Promise<RecTopic> {
    return request<RecTopic>(`/api/discover/topics/${id}`, {
      method: "DELETE",
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
