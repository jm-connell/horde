import type { DuplicateGroup, ImportScanResult, Video } from "../types";
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

  listReview(): Promise<Video[]> {
    return collectPages((cursor) => {
      const qs = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (cursor) qs.set("cursor", cursor);
      return request<Page<Video>>(`/api/review?${qs}`);
    });
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
