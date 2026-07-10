import type {
  AiProcessResult,
  AiSettings,
  AiStatus,
  AppSettings,
  ChannelFeedPage,
  ChannelStat,
  DownloadJob,
  DownloadOverrides,
  DownloadPreview,
  DownloadQueueStatus,
  DuplicateGroup,
  Playlist,
  PlaylistDetail,
  PlaylistPreviewData,
  RecommendationsResponse,
  StorageStats,
  SystemStats,
  TagStat,
  Video,
  VideoUpdate,
} from "./types";

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(url, init);
  if (!resp.ok) {
    let detail = resp.statusText;
    try {
      const body = await resp.json();
      detail = body.detail ?? detail;
    } catch {
      // non-JSON error body; keep status text
    }
    throw new Error(detail);
  }
  if (resp.status === 204) return undefined as T;
  return resp.json() as Promise<T>;
}

export interface LibraryQuery {
  q?: string;
  channel?: string;
  tag?: string;
  sort?: string;
  order?: string;
  continue_watching?: boolean;
  watched_only?: boolean;
  seed?: number;
}

export interface ChannelQuery {
  sort?: string;
  order?: string;
}

export interface ChannelFeedQuery {
  channel?: string;
  url?: string;
  offset?: number;
  limit?: number;
}

export const api = {
  listVideos(params: LibraryQuery = {}): Promise<Video[]> {
    const qs = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
    });
    return request<Video[]>(`/api/videos?${qs.toString()}`);
  },

  saveProgress(id: number, positionSec: number): Promise<void> {
    return request<void>(`/api/videos/${id}/progress`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ position_sec: positionSec }),
    });
  },

  getVideo(id: number): Promise<Video> {
    return request<Video>(`/api/videos/${id}`);
  },

  getRelatedVideos(id: number, limit = 6): Promise<Video[]> {
    return request<Video[]>(
      `/api/videos/${id}/related?limit=${encodeURIComponent(String(limit))}`
    );
  },

  updateVideo(id: number, payload: VideoUpdate): Promise<Video> {
    return request<Video>(`/api/videos/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  },

  deleteVideo(id: number, deleteFile = false): Promise<void> {
    return request<void>(`/api/videos/${id}?delete_file=${deleteFile}`, {
      method: "DELETE",
    });
  },

  bulkDeleteVideos(ids: number[], deleteFiles = false): Promise<void> {
    return request<void>("/api/videos/bulk-delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ video_ids: ids, delete_files: deleteFiles }),
    });
  },

  bulkUpdateNotes(ids: number[], notes: string): Promise<void> {
    return request<void>("/api/videos/bulk-notes", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ video_ids: ids, notes }),
    });
  },

  refreshMetadata(id: number): Promise<Video> {
    return request<Video>(`/api/videos/${id}/refresh-metadata`, {
      method: "POST",
    });
  },

  refreshMetadataBulk(
    videoIds?: number[]
  ): Promise<{ refreshed: number; failed: number; skipped: number }> {
    return request("/api/videos/refresh-metadata", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ video_ids: videoIds ?? [] }),
    });
  },

  uploadThumbnail(id: number, file: File): Promise<Video> {
    const form = new FormData();
    form.append("file", file);
    return request<Video>(`/api/videos/${id}/thumbnail`, {
      method: "POST",
      body: form,
    });
  },

  listChannels(params: ChannelQuery = {}): Promise<ChannelStat[]> {
    const qs = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
      if (v) qs.set(k, String(v));
    });
    const query = qs.toString();
    return request<ChannelStat[]>(`/api/channels${query ? `?${query}` : ""}`);
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

  renameChannel(oldName: string, newName: string): Promise<{ updated: number }> {
    return request<{ updated: number }>("/api/channels", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ old_name: oldName, new_name: newName }),
    });
  },

  listTags(): Promise<string[]> {
    return request<string[]>("/api/tags");
  },

  tagStats(channel?: string): Promise<TagStat[]> {
    const qs = channel ? `?channel=${encodeURIComponent(channel)}` : "";
    return request<TagStat[]>(`/api/tags/stats${qs}`);
  },

  storageStats(): Promise<StorageStats> {
    return request<StorageStats>("/api/stats/storage");
  },

  getAppSettings(): Promise<AppSettings> {
    return request<AppSettings>("/api/settings");
  },

  updateAppSettings(
    patch: Partial<Omit<AppSettings, "ai">> & { ai?: Partial<AiSettings> }
  ): Promise<AppSettings> {
    return request<AppSettings>("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
  },

  getAiStatus(): Promise<AiStatus> {
    return request<AiStatus>("/api/ai/status");
  },

  testAiConnection(base_url?: string): Promise<{
    ok: boolean;
    base_url?: string | null;
    detail?: string;
    models?: string[];
  }> {
    return request("/api/ai/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ base_url: base_url || null }),
    });
  },

  processAiLibrary(
    action:
      | "all"
      | "all_recent"
      | "all_full"
      | "embeds"
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

  getSystemStats(): Promise<SystemStats> {
    return request<SystemStats>("/api/system/stats");
  },

  uploadBackground(
    file: File
  ): Promise<{
    id: string;
    url: string;
    mime: string;
    animated: boolean;
    filename?: string;
  }> {
    const form = new FormData();
    form.append("file", file);
    return request("/api/backgrounds", {
      method: "POST",
      body: form,
    });
  },

  listBackgrounds(): Promise<{
    items: {
      id: string;
      url: string;
      mime: string;
      animated: boolean;
      filename?: string;
    }[];
  }> {
    return request("/api/backgrounds");
  },

  deleteBackground(id: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(
      `/api/backgrounds/${encodeURIComponent(id)}`,
      { method: "DELETE" }
    );
  },

  extractBackgroundPalette(id: string): Promise<{ colors: string[] }> {
    return request<{ colors: string[] }>(
      `/api/backgrounds/${encodeURIComponent(id)}/palette`,
      { method: "POST" }
    );
  },

  pauseAi(): Promise<{ paused: boolean }> {
    return request<{ paused: boolean }>("/api/ai/pause", { method: "POST" });
  },

  resumeAi(): Promise<{ paused: boolean }> {
    return request<{ paused: boolean }>("/api/ai/resume", { method: "POST" });
  },

  getRecommendations(
    category?: string,
    opts?: { limit?: number; offset?: number }
  ): Promise<RecommendationsResponse> {
    const params = new URLSearchParams();
    if (category) params.set("category", category);
    if (opts?.limit != null) params.set("limit", String(opts.limit));
    if (opts?.offset != null) params.set("offset", String(opts.offset));
    const qs = params.toString() ? `?${params}` : "";
    return request<RecommendationsResponse>(`/api/ai/recommendations${qs}`);
  },

  refreshVideoTags(id: number): Promise<Video> {
    return request<Video>(`/api/videos/${id}/ai/refresh-tags`, { method: "POST" });
  },

  listDuplicateGroups(): Promise<DuplicateGroup[]> {
    return request<DuplicateGroup[]>("/api/review/groups");
  },

  listReview(): Promise<Video[]> {
    return request<Video[]>("/api/review");
  },

  skipReview(id: number): Promise<Video> {
    return request<Video>(`/api/review/${id}/skip`, { method: "POST" });
  },

  listPresets(): Promise<string[]> {
    return request<string[]>("/api/downloads/presets");
  },

  previewDownload(url: string): Promise<DownloadPreview> {
    return request<DownloadPreview>(
      `/api/downloads/preview?url=${encodeURIComponent(url)}`
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

  listJobs(): Promise<DownloadJob[]> {
    return request<DownloadJob[]>("/api/downloads");
  },

  getJob(jobId: number): Promise<DownloadJob> {
    return request<DownloadJob>(`/api/downloads/${jobId}`);
  },

  updateJob(
    jobId: number,
    overrides: DownloadOverrides
  ): Promise<DownloadJob> {
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

  dismissJob(jobId: number): Promise<void> {
    return request<void>(`/api/downloads/${jobId}`, { method: "DELETE" });
  },

  dismissFinished(): Promise<void> {
    return request<void>("/api/downloads/dismiss-finished", { method: "POST" });
  },

  getQueueStatus(): Promise<DownloadQueueStatus> {
    return request<DownloadQueueStatus>("/api/downloads/queue/status");
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
    normalize_volume = false
  ): Promise<Video> {
    return request<Video>(`/api/videos/${id}/redownload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quality_preset, normalize_volume }),
    });
  },

  listPlaylists(): Promise<Playlist[]> {
    return request<Playlist[]>("/api/playlists");
  },

  getPlaylist(id: number): Promise<PlaylistDetail> {
    return request<PlaylistDetail>(`/api/playlists/${id}`);
  },

  createPlaylist(name: string, description?: string): Promise<Playlist> {
    return request<Playlist>("/api/playlists", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, description }),
    });
  },

  deletePlaylist(id: number): Promise<void> {
    return request<void>(`/api/playlists/${id}`, { method: "DELETE" });
  },

  addToPlaylist(playlistId: number, videoId: number): Promise<PlaylistDetail> {
    return request<PlaylistDetail>(`/api/playlists/${playlistId}/items`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ video_id: videoId }),
    });
  },

  bulkAddToPlaylist(playlistId: number, videoIds: number[]): Promise<void> {
    return request<void>(`/api/playlists/${playlistId}/items/bulk`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ video_ids: videoIds }),
    });
  },

  removeFromPlaylist(playlistId: number, videoId: number): Promise<void> {
    return request<void>(`/api/playlists/${playlistId}/items/${videoId}`, {
      method: "DELETE",
    });
  },

  reorderPlaylist(
    playlistId: number,
    videoIds: number[]
  ): Promise<PlaylistDetail> {
    return request<PlaylistDetail>(`/api/playlists/${playlistId}/reorder`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ video_ids: videoIds }),
    });
  },

  importPlaylist(
    url: string,
    quality_preset: string,
    opts: { name?: string; entries?: string[] } = {}
  ): Promise<Playlist> {
    return request<Playlist>("/api/playlists/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url,
        quality_preset,
        name: opts.name,
        entries: opts.entries,
      }),
    });
  },

  previewPlaylist(url: string): Promise<PlaylistPreviewData> {
    return request<PlaylistPreviewData>(
      `/api/playlists/preview?url=${encodeURIComponent(url)}`
    );
  },

  estimatePlaylistSizes(
    urls: string[]
  ): Promise<{ sizes: Record<string, Record<string, number>> }> {
    return request("/api/playlists/estimate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ urls }),
    });
  },
};

export function thumbnailUrl(video: Video): string | null {
  return video.has_thumbnail ? `/api/thumbnails/${video.id}` : null;
}

export function absoluteUrl(path: string): string {
  return new URL(path, window.location.origin).href;
}

export function streamUrl(id: number): string {
  return `/api/videos/${id}/stream`;
}

export function downloadFileUrl(id: number): string {
  return `/api/videos/${id}/file`;
}

export function subtitleUrl(id: number, lang: string): string {
  return `/api/videos/${id}/subtitles/${encodeURIComponent(lang)}`;
}
