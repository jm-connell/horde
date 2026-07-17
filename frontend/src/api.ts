import type {
  AiProcessResult,
  AiSettings,
  AiStatus,
  AppSettings,
  ChannelCatalogStatus,
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
  StreamPreviewMeta,
  SystemStats,
  TagStat,
  UpdateCheck,
  Video,
  VideoUpdate,
  SpriteMeta,
} from "./types";

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let resp: Response;
  try {
    resp = await fetch(url, init);
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw err;
    }
    throw err;
  }
  if (!resp.ok) {
    let detail = resp.statusText;
    try {
      const body = await resp.json();
      detail = body.detail ?? detail;
    } catch {
      // non-JSON error body; keep status text
    }
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
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
  /** When true, fetch/merge from YouTube (slower). Default prefers local catalog. */
  live?: boolean;
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

  getRelatedVideos(
    id: number,
    limit = 8,
    offset = 0
  ): Promise<Video[]> {
    const qs = new URLSearchParams({
      limit: String(limit),
      offset: String(offset),
    });
    return request<Video[]>(
      `/api/videos/${id}/related?${qs.toString()}`
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
    videoIds?: number[],
    fields?: string[]
  ): Promise<{
    refreshed: number;
    failed: number;
    skipped: number;
    started?: boolean;
    detail?: string;
    total?: number;
  }> {
    return request("/api/videos/refresh-metadata", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        video_ids: videoIds ?? [],
        fields: fields ?? [],
      }),
    });
  },

  getMetadataSyncStatus(): Promise<{
    running: boolean;
    total: number;
    done: number;
    failed: number;
    skipped: number;
    current_title: string | null;
    current_video_id: number | null;
    fields: string[];
    last_error: string | null;
    finished_at: string | null;
  }> {
    return request("/api/videos/refresh-metadata/status");
  },

  uploadThumbnail(id: number, file: File): Promise<Video> {
    const form = new FormData();
    form.append("file", file);
    return request<Video>(`/api/videos/${id}/thumbnail`, {
      method: "POST",
      body: form,
    });
  },

  generateThumbnailCandidates(
    id: number,
    count = 8
  ): Promise<{
    candidates: { index: number; at_seconds: number; url: string }[];
  }> {
    return request(`/api/videos/${id}/thumbnail/candidates?count=${count}`, {
      method: "POST",
    });
  },

  selectThumbnailCandidate(id: number, index: number): Promise<Video> {
    return request<Video>(`/api/videos/${id}/thumbnail/candidates/${index}`, {
      method: "POST",
    });
  },

  getSpriteMeta(id: number): Promise<SpriteMeta> {
    return request<SpriteMeta>(`/api/videos/${id}/sprites/meta`);
  },

  ensureSprites(id: number): Promise<{ status: "ready" | "generating" }> {
    return request(`/api/videos/${id}/sprites/generate`, { method: "POST" });
  },

  listChannels(params: ChannelQuery = {}): Promise<ChannelStat[]> {
    const qs = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
      if (v) qs.set(k, String(v));
    });
    const query = qs.toString();
    return request<ChannelStat[]>(`/api/channels${query ? `?${query}` : ""}`);
  },

  searchChannels(
    q: string,
    limit = 8
  ): Promise<{
    results: {
      name: string;
      url: string;
      thumbnail_url: string | null;
      subscriber_count: number | null;
    }[];
  }> {
    const qs = new URLSearchParams({
      q,
      limit: String(limit),
    });
    return request(`/api/channels/search?${qs.toString()}`);
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

  searchChannelCatalog(params: {
    q: string;
    channel?: string;
    url?: string;
    limit?: number;
  }): Promise<ChannelFeedPage> {
    const qs = new URLSearchParams();
    qs.set("q", params.q);
    if (params.channel) qs.set("channel", params.channel);
    if (params.url) qs.set("url", params.url);
    if (params.limit != null) qs.set("limit", String(params.limit));
    return request<ChannelFeedPage>(
      `/api/channels/catalog/search?${qs.toString()}`
    );
  },

  getChannelCatalogStatus(): Promise<ChannelCatalogStatus> {
    return request<ChannelCatalogStatus>("/api/channels/catalog/status");
  },

  indexChannelCatalog(params: {
    channel?: string;
    url?: string;
    force?: boolean;
  } = {}): Promise<{
    queued: number;
    skipped: number;
    catalog_id: number | null;
    detail: string;
  }> {
    return request("/api/channels/catalog/index", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channel: params.channel ?? null,
        url: params.url ?? null,
        force: params.force ?? true,
      }),
    });
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

  applyAiWorkload(profile?: "light" | "normal" | "heavy"): Promise<{
    ok: boolean;
    embed_model_changed?: boolean;
    detail?: string;
    runtime?: Record<string, unknown>;
  }> {
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

  getSystemStats(): Promise<SystemStats> {
    return request<SystemStats>("/api/system/stats");
  },

  checkUpdates(refresh = false): Promise<UpdateCheck> {
    const qs = refresh ? "?refresh=true" : "";
    return request<UpdateCheck>(`/api/updates${qs}`);
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

  uploadFont(
    file: File
  ): Promise<{ id: string; url: string; mime: string; filename?: string }> {
    const form = new FormData();
    form.append("file", file);
    return request("/api/fonts", {
      method: "POST",
      body: form,
    });
  },

  deleteFont(id: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(
      `/api/fonts/${encodeURIComponent(id)}`,
      { method: "DELETE" }
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

  listDuplicateGroups(): Promise<DuplicateGroup[]> {
    return request<DuplicateGroup[]>("/api/review/groups");
  },

  listReview(): Promise<Video[]> {
    return request<Video[]>("/api/review");
  },

  listImport(): Promise<Video[]> {
    return request<Video[]>("/api/review");
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

  listPresets(): Promise<string[]> {
    return request<string[]>("/api/downloads/presets");
  },

  previewDownload(url: string): Promise<DownloadPreview> {
    return request<DownloadPreview>(
      `/api/downloads/preview?url=${encodeURIComponent(url)}`
    );
  },

  getPreviewMeta(url: string): Promise<StreamPreviewMeta> {
    return request<StreamPreviewMeta>(
      `/api/preview/meta?url=${encodeURIComponent(url)}`
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

export function spritesMetaUrl(id: number): string {
  return `/api/videos/${id}/sprites/meta`;
}

export function spritesImageUrl(id: number): string {
  return `/api/videos/${id}/sprites`;
}

export function absoluteUrl(path: string): string {
  return new URL(path, window.location.origin).href;
}

export function streamUrl(id: number): string {
  return `/api/videos/${id}/stream`;
}

export function previewStreamUrl(url: string): string {
  return `/api/preview/stream?url=${encodeURIComponent(url)}`;
}

export function downloadFileUrl(id: number): string {
  return `/api/videos/${id}/file`;
}

export function subtitleUrl(id: number, lang: string): string {
  return `/api/videos/${id}/subtitles/${encodeURIComponent(lang)}`;
}
