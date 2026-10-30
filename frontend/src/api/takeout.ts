import type {
  RewatchedVideo,
  TakeoutApplyRequest,
  TakeoutApplyResult,
  TakeoutHistorySummary,
  TakeoutImportResult,
} from "../types";
import {
  CSRF_HEADER,
  jsonInit,
  type Page,
  type ReadOptions,
  request,
} from "./client";

export const takeoutApi = {
  /** The signed-in account's imported YouTube watch history, summed up. */
  takeoutHistory(opts?: ReadOptions): Promise<TakeoutHistorySummary> {
    return request<TakeoutHistorySummary>("/api/takeout/history", opts);
  },

  clearTakeoutHistory(): Promise<{ removed_views: number }> {
    return request("/api/takeout/history", { method: "DELETE" });
  },

  /**
   * Upload a Google Takeout export (its .zip parts, or loose files). The
   * server stores the watch history right away and lists the subscriptions
   * and playlists for `applyTakeout`.
   */
  importTakeout(
    files: File[],
    onProgress?: (pct: number) => void
  ): Promise<TakeoutImportResult> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/takeout/import");
      xhr.setRequestHeader(CSRF_HEADER, "1");
      xhr.responseType = "json";
      xhr.upload.onprogress = (e) => {
        if (!onProgress || !e.lengthComputable) return;
        onProgress(Math.round((e.loaded / e.total) * 100));
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(xhr.response as TakeoutImportResult);
          return;
        }
        let detail = xhr.statusText || "Import failed";
        const body: unknown = xhr.response;
        if (body && typeof body === "object" && "detail" in body) {
          const d = (body as { detail: unknown }).detail;
          detail = typeof d === "string" ? d : detail;
        }
        reject(new Error(detail));
      };
      xhr.onerror = () => reject(new Error("Network error during upload"));
      xhr.onabort = () => reject(new Error("Upload aborted"));
      const form = new FormData();
      for (const file of files) form.append("files", file);
      xhr.send(form);
    });
  },

  /** Follow the chosen subscriptions and import the chosen playlists. */
  applyTakeout(choice: TakeoutApplyRequest): Promise<TakeoutApplyResult> {
    return request<TakeoutApplyResult>(
      "/api/takeout/apply",
      jsonInit("POST", choice)
    );
  },

  /** Videos watched several times on YouTube that are not downloaded. */
  rewatched(
    cursor: string | null,
    limit = 12,
    opts?: ReadOptions
  ): Promise<Page<RewatchedVideo>> {
    const qs = new URLSearchParams({ limit: String(limit) });
    if (cursor) qs.set("cursor", cursor);
    return request<Page<RewatchedVideo>>(`/api/takeout/rewatched?${qs}`, opts);
  },
};
