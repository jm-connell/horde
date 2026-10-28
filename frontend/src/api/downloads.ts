import type {
  ClipCreate,
  DownloadBulkResult,
  DownloadJob,
  DownloadOverrides,
  DownloadPreview,
  DownloadQueueStatus,
  StreamPreviewMeta,
  Video,
} from "../types";
import { type ReadOptions, request } from "./client";

export const downloadsApi = {
  listPresets(opts?: ReadOptions): Promise<string[]> {
    return request<string[]>("/api/downloads/presets", opts);
  },

  previewDownload(url: string, opts?: ReadOptions): Promise<DownloadPreview> {
    return request<DownloadPreview>(
      `/api/downloads/preview?url=${encodeURIComponent(url)}`,
      opts
    );
  },

  getPreviewMeta(url: string, opts?: ReadOptions): Promise<StreamPreviewMeta> {
    return request<StreamPreviewMeta>(
      `/api/preview/meta?url=${encodeURIComponent(url)}`,
      opts
    );
  },

  createDownload(
    url: string,
    quality_preset: string,
    overrides: DownloadOverrides = {}
  ): Promise<DownloadJob> {
    return request<DownloadJob>("/api/downloads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, quality_preset, ...overrides }),
    });
  },

  /** Queue part of a stream as its own library video. */
  createClip(clip: ClipCreate): Promise<DownloadJob> {
    return request<DownloadJob>("/api/downloads/clips", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(clip),
    });
  },

  bulkCreateDownloads(
    urls: string[],
    quality_preset: string,
    extra: {
      destination?: DownloadJob["destination"];
      normalize_volume?: boolean;
      video_codec?: string;
    } = {}
  ): Promise<DownloadBulkResult> {
    return request<DownloadBulkResult>("/api/downloads/bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ urls, quality_preset, ...extra }),
    });
  },

  listJobs(opts?: ReadOptions): Promise<DownloadJob[]> {
    return request<DownloadJob[]>("/api/downloads", opts);
  },

  getJob(jobId: number): Promise<DownloadJob> {
    return request<DownloadJob>(`/api/downloads/${jobId}`);
  },

  updateJob(jobId: number, overrides: DownloadOverrides): Promise<DownloadJob> {
    return request<DownloadJob>(`/api/downloads/${jobId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(overrides),
    });
  },

  cancelJob(jobId: number): Promise<DownloadJob> {
    return request<DownloadJob>(`/api/downloads/${jobId}/cancel`, {
      method: "POST",
    });
  },

  retryJob(
    jobId: number,
    overrides: DownloadOverrides = {}
  ): Promise<DownloadJob> {
    return request<DownloadJob>(`/api/downloads/${jobId}/retry`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(overrides),
    });
  },

  changeJobQuality(
    jobId: number,
    quality_preset: string
  ): Promise<DownloadJob> {
    return request<DownloadJob>(`/api/downloads/${jobId}/quality`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quality_preset }),
    });
  },

  dismissJob(jobId: number): Promise<void> {
    return request<void>(`/api/downloads/${jobId}`, { method: "DELETE" });
  },

  dismissFinished(): Promise<void> {
    return request<void>("/api/downloads/dismiss-finished", { method: "POST" });
  },

  getQueueStatus(opts?: ReadOptions): Promise<DownloadQueueStatus> {
    return request<DownloadQueueStatus>("/api/downloads/queue/status", opts);
  },

  pauseQueue(): Promise<DownloadQueueStatus> {
    return request<DownloadQueueStatus>("/api/downloads/queue/pause", {
      method: "POST",
    });
  },

  resumeQueue(): Promise<DownloadQueueStatus> {
    return request<DownloadQueueStatus>("/api/downloads/queue/resume", {
      method: "POST",
    });
  },

  redownloadVideo(
    id: number,
    quality_preset: string,
    normalize_volume = false,
    video_codec?: string
  ): Promise<Video> {
    return request<Video>(`/api/videos/${id}/redownload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quality_preset, normalize_volume, video_codec }),
    });
  },
};
