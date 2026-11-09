import type {
  AiConnectionTest,
  HelpAssistantInfo,
  HelpCatalog,
  HelpSearchResult,
  AiJobRow,
  AiProcessResult,
  AiStatus,
  OpenRouterCosts,
  StreamAi,
  StreamRelatedPage,
  Video,
} from "../types";
import type { ApiResponse } from "./typed";
import { type ReadOptions, request } from "./client";

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

  /** The pages and settings Ask may link to or change. */
  getHelpCatalog(opts?: ReadOptions): Promise<HelpCatalog> {
    return request<HelpCatalog>("/api/ai/help/catalog", opts);
  },

  /** What Ask runs on and where questions are sent. */
  getHelpInfo(opts?: ReadOptions): Promise<HelpAssistantInfo> {
    return request<HelpAssistantInfo>("/api/ai/help/info", opts);
  },

  /** Ask without AI: matching documentation and settings. */
  searchHelp(q: string, page: string): Promise<HelpSearchResult> {
    const qs = new URLSearchParams({ q, page });
    return request<HelpSearchResult>(`/api/ai/help/search?${qs}`);
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

  getStreamRelated(
    url: string,
    limit = 24,
    opts?: ReadOptions,
    cursor?: string | null
  ): Promise<StreamRelatedPage> {
    const more = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
    return request<StreamRelatedPage>(
      `/api/preview/related?url=${encodeURIComponent(url)}&limit=${limit}${more}`,
      opts
    );
  },
};
