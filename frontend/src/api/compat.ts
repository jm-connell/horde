import type { CompatState, CompatSummary } from "../types";
import type { ApiResponse } from "./typed";
import { type ReadOptions, request } from "./client";

export const compatApi = {
  getCompat(videoId: number): Promise<CompatState> {
    return request<CompatState>(`/api/videos/${videoId}/compat`);
  },

  requestCompat(videoId: number): Promise<CompatState> {
    return request<CompatState>(`/api/videos/${videoId}/compat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prefer_download: true }),
    });
  },

  /** Is the stored original playable by WebKit (Safari, every iOS browser)? */
  getSafariPrep(videoId: number): Promise<CompatState> {
    return request<CompatState>(`/api/videos/${videoId}/compat/safari`);
  },

  /** Queue the in-place Safari remux. GET /stream never does this itself. */
  requestSafariPrep(videoId: number): Promise<CompatState> {
    return request<CompatState>(`/api/videos/${videoId}/compat/safari`, {
      method: "POST",
    });
  },

  getCompatSummary(opts?: ReadOptions): Promise<CompatSummary> {
    return request<CompatSummary>("/api/compat/summary", opts);
  },

  startCompatBackfill(): Promise<ApiResponse<"/api/compat/backfill", "post">> {
    return request("/api/compat/backfill", { method: "POST" });
  },

  convertLibraryToH264(): Promise<
    ApiResponse<"/api/compat/convert-library", "post">
  > {
    return request("/api/compat/convert-library", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: true }),
    });
  },

  cancelCompatJobs(
    kind?: "compat" | "convert"
  ): Promise<ApiResponse<"/api/compat/cancel", "post">> {
    return request("/api/compat/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(kind ? { kind } : {}),
    });
  },
};
