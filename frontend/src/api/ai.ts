import type {
  AiConnectionTest,
  HelpChatTurn,
  AiJobRow,
  AiProcessResult,
  AiStatus,
  OpenRouterCosts,
  RecommendationsResponse,
  StreamAi,
  StreamRelatedPage,
  Video,
} from "../types";
import type { ApiResponse } from "./typed";
import {
  type ChatStreamOptions,
  postEventStream,
  type ReadOptions,
  request,
} from "./client";

export const aiApi = {
  getAiStatus(opts?: ReadOptions): Promise<AiStatus> {
    return request<AiStatus>("/api/ai/status", opts);
  },

  listAiJobs(status?: string, limit = 50): Promise<AiJobRow[]> {
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    params.set("limit", String(limit));
    return request(`/api/ai/jobs?${params}`);
  },

  retryAiJob(
    jobId: number
  ): Promise<ApiResponse<"/api/ai/jobs/{job_id}/retry", "post">> {
    return request(`/api/ai/jobs/${jobId}/retry`, { method: "POST" });
  },

  retryFailedAiJobs(): Promise<
    ApiResponse<"/api/ai/jobs/retry-failed", "post">
  > {
    return request("/api/ai/jobs/retry-failed", { method: "POST" });
  },

  cancelAiJob(
    jobId: number
  ): Promise<ApiResponse<"/api/ai/jobs/{job_id}/cancel", "post">> {
    return request(`/api/ai/jobs/${jobId}/cancel`, { method: "POST" });
  },

  clearFailedAiJobs(
    keepDays = 0
  ): Promise<ApiResponse<"/api/ai/jobs/clear-failed", "post">> {
    return request(`/api/ai/jobs/clear-failed?keep_days=${keepDays}`, {
      method: "POST",
    });
  },

  /** Probe an endpoint and list its models; blank fields fall back to the saved connection. */
  testAiConnection(
    body: {
      target?: "chat" | "embed";
      base_url?: string | null;
      api_key?: string | null;
    },
    opts?: ReadOptions
  ): Promise<AiConnectionTest> {
    return request<AiConnectionTest>("/api/ai/test", {
      ...opts,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  },

  detectAiServers(): Promise<ApiResponse<"/api/ai/detect", "post">> {
    return request("/api/ai/detect", { method: "POST" });
  },

  getAiCosts(opts?: ReadOptions): Promise<OpenRouterCosts> {
    return request<OpenRouterCosts>("/api/ai/costs", opts);
  },

  applyAiWorkload(
    profile?: "light" | "normal" | "heavy"
  ): Promise<ApiResponse<"/api/ai/apply-workload", "post">> {
    return request("/api/ai/apply-workload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile: profile || null }),
    });
  },

  processAiLibrary(
    action:
      | "all"
      | "all_recent"
      | "all_full"
      | "embeds"
      | "reindex_embeds"
      | "missing_tags"
      | "full_tags"
      | "categories" = "all"
  ): Promise<AiProcessResult> {
    return request<AiProcessResult>("/api/ai/process", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
  },

  pauseAi(): Promise<ApiResponse<"/api/ai/pause", "post">> {
    return request("/api/ai/pause", { method: "POST" });
  },

  resumeAi(): Promise<ApiResponse<"/api/ai/resume", "post">> {
    return request("/api/ai/resume", { method: "POST" });
  },

  getRecommendations(
    category?: string,
    opts?: { limit?: number; offset?: number; includeStreams?: boolean }
  ): Promise<RecommendationsResponse> {
    const params = new URLSearchParams();
    if (category) params.set("category", category);
    if (opts?.includeStreams) params.set("include_streams", "true");
    if (opts?.limit != null) params.set("limit", String(opts.limit));
    if (opts?.offset != null) params.set("offset", String(opts.offset));
    const qs = params.toString() ? `?${params}` : "";
    return request<RecommendationsResponse>(`/api/ai/recommendations${qs}`);
  },

  refreshVideoTags(id: number): Promise<Video> {
    return request<Video>(`/api/videos/${id}/ai/refresh-tags`, {
      method: "POST",
    });
  },

  summarizeVideo(
    id: number,
    opts?: { force?: boolean; signal?: AbortSignal }
  ): Promise<Video> {
    const qs = opts?.force ? "?force=true" : "";
    return request<Video>(`/api/videos/${id}/ai/summarize${qs}`, {
      method: "POST",
      signal: opts?.signal,
    });
  },

  generateVideoChapters(
    id: number,
    opts?: { force?: boolean; signal?: AbortSignal }
  ): Promise<Video> {
    const qs = opts?.force ? "?force=true" : "";
    return request<Video>(`/api/videos/${id}/ai/chapters${qs}`, {
      method: "POST",
      signal: opts?.signal,
    });
  },

  getVideoAiChat(
    id: number
  ): Promise<ApiResponse<"/api/videos/{video_id}/ai/chat", "get">> {
    return request(`/api/videos/${id}/ai/chat`);
  },

  clearVideoAiChat(
    id: number
  ): Promise<ApiResponse<"/api/videos/{video_id}/ai/chat", "delete">> {
    return request(`/api/videos/${id}/ai/chat`, {
      method: "DELETE",
    });
  },

  /**
   * Stream a chat turn via SSE. Calls ``onEvent`` for each parsed payload.
   * Resolves when the stream ends (done or error event also delivered).
   */
  streamVideoAiChat(
    id: number,
    message: string,
    opts: ChatStreamOptions
  ): Promise<void> {
    return postEventStream(`/api/videos/${id}/ai/chat`, { message }, opts);
  },

  /**
   * Ask about Horde: one question and the conversation before it (the server
   * keeps none). Events as for video chat, plus `sources` before the reply.
   */
  streamHelpChat(
    message: string,
    history: HelpChatTurn[],
    opts: ChatStreamOptions
  ): Promise<void> {
    return postEventStream("/api/ai/help/chat", { message, history }, opts);
  },

  // --- AI for a streamed (not downloaded) video; all need `use_ai` ---

  getStreamAi(url: string, opts?: ReadOptions): Promise<StreamAi> {
    return request<StreamAi>(
      `/api/preview/ai?url=${encodeURIComponent(url)}`,
      opts
    );
  },

  summarizeStream(
    url: string,
    opts?: { force?: boolean; signal?: AbortSignal }
  ): Promise<StreamAi> {
    return request<StreamAi>("/api/preview/ai/summarize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, force: !!opts?.force }),
      signal: opts?.signal,
    });
  },

  generateStreamChapters(
    url: string,
    opts?: { force?: boolean; signal?: AbortSignal }
  ): Promise<StreamAi> {
    return request<StreamAi>("/api/preview/ai/chapters", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, force: !!opts?.force }),
      signal: opts?.signal,
    });
  },

  getStreamAiChat(
    url: string
  ): Promise<ApiResponse<"/api/preview/ai/chat", "get">> {
    return request(`/api/preview/ai/chat?url=${encodeURIComponent(url)}`);
  },

  clearStreamAiChat(
    url: string
  ): Promise<ApiResponse<"/api/preview/ai/chat", "delete">> {
    return request(`/api/preview/ai/chat?url=${encodeURIComponent(url)}`, {
      method: "DELETE",
    });
  },

  streamStreamAiChat(
    url: string,
    message: string,
    opts: ChatStreamOptions
  ): Promise<void> {
    return postEventStream("/api/preview/ai/chat", { url, message }, opts);
  },

  getStreamRelated(
    url: string,
    limit = 24,
    opts?: ReadOptions
  ): Promise<StreamRelatedPage> {
    return request<StreamRelatedPage>(
      `/api/preview/related?url=${encodeURIComponent(url)}&limit=${limit}`,
      opts
    );
  },
};
