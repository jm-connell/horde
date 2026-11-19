import type {
  ApproveSuggestedResult,
  DuplicateGroup,
  ImportScanResult,
  ImportSuggestion,
  ReviewItem,
  Video,
} from "../types";
import {
  collectPages,
  CSRF_HEADER,
  type Page,
  PAGE_SIZE,
  type ReadOptions,
  request,
} from "./client";

export const reviewApi = {
  listDuplicateGroups(): Promise<DuplicateGroup[]> {
    return collectPages((cursor) => {
      const qs = new URLSearchParams({ limit: "100" });
      if (cursor) qs.set("cursor", cursor);
      return request<Page<DuplicateGroup>>(`/api/review/groups?${qs}`);
    });
  },

  /** How many videos wait for review: one row and the server's count, not the list. */
  async reviewCount(opts?: ReadOptions): Promise<number> {
    const page = await request<Page<Video>>(
      "/api/review?limit=1&include_total=true",
      opts
    );
    return page.total ?? page.items.length;
  },

  /** The whole import queue, each item with what its files on disk suggest. */
  listReview(): Promise<ReviewItem[]> {
    return collectPages((cursor) => {
      const qs = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (cursor) qs.set("cursor", cursor);
      return request<Page<ReviewItem>>(`/api/review?${qs}`);
    });
  },

  /** Approve one batch (up to 100) of items whose title and channel are known. */
  approveSuggested(): Promise<ApproveSuggestedResult> {
    return request<ApproveSuggestedResult>("/api/review/approve-suggested", {
      method: "POST",
    });
  },

  /** What YouTube says about the video a review item is a copy of. */
  lookupOnYoutube(id: number): Promise<ImportSuggestion> {
    return request<ImportSuggestion>(`/api/review/${id}/youtube`);
  },

  /** Look a review item up on YouTube and approve it with what YouTube says. */
  approveFromYoutube(id: number): Promise<ApproveSuggestedResult> {
    return request<ApproveSuggestedResult>(
      `/api/review/${id}/approve-from-youtube`,
      { method: "POST" }
    );
  },

  scanImport(): Promise<ImportScanResult> {
    return request<ImportScanResult>("/api/review/scan", { method: "POST" });
  },

  skipReview(id: number): Promise<Video> {
    return request<Video>(`/api/review/${id}/skip`, { method: "POST" });
  },

  skipImport(id: number): Promise<Video> {
    return request<Video>(`/api/review/${id}/skip`, { method: "POST" });
  },

  uploadImportVideo(
    file: File,
    onProgress?: (pct: number) => void
  ): Promise<Video> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/review/upload");
      xhr.setRequestHeader(CSRF_HEADER, "1");
      xhr.responseType = "json";
      xhr.upload.onprogress = (e) => {
        if (!onProgress || !e.lengthComputable) return;
        onProgress(Math.round((e.loaded / e.total) * 100));
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(xhr.response as Video);
          return;
        }
        let detail = xhr.statusText || "Upload failed";
        const body = xhr.response;
        if (body && typeof body === "object" && "detail" in body) {
          const d = (body as { detail: unknown }).detail;
          detail = typeof d === "string" ? d : detail;
        }
        reject(new Error(detail));
      };
      xhr.onerror = () => reject(new Error("Network error during upload"));
      xhr.onabort = () => reject(new Error("Upload aborted"));
      const form = new FormData();
      form.append("file", file);
      xhr.send(form);
    });
  },
};
