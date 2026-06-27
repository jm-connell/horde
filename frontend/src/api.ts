import type {
  ChannelStat,
  DownloadJob,
  DownloadOverrides,
  DownloadPreview,
  Playlist,
  PlaylistDetail,
  StorageStats,
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

  importPlaylist(url: string, quality_preset: string): Promise<Playlist> {
    return request<Playlist>("/api/playlists/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, quality_preset }),
    });
  },
};

export function thumbnailUrl(video: Video): string | null {
  return video.has_thumbnail ? `/api/thumbnails/${video.id}` : null;
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
