import type {
  Playlist,
  PlaylistDetail,
  PlaylistPreviewData,
  PlaylistVisibility,
} from "../types";
import type { ApiResponse } from "./typed";
import { type ReadOptions, request } from "./client";

export const playlistsApi = {
  listPlaylists(opts?: ReadOptions): Promise<Playlist[]> {
    return request<Playlist[]>("/api/playlists", opts);
  },

  getPlaylist(id: number, opts?: ReadOptions): Promise<PlaylistDetail> {
    return request<PlaylistDetail>(`/api/playlists/${id}`, opts);
  },

  /** Without `visibility` the server decides: App-wide for those who may share, else Private. */
  createPlaylist(
    name: string,
    opts: { description?: string; visibility?: PlaylistVisibility } = {}
  ): Promise<Playlist> {
    return request<Playlist>("/api/playlists", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, ...opts }),
    });
  },

  updatePlaylist(
    id: number,
    patch: {
      name?: string;
      description?: string;
      subscribed?: boolean;
      quality_preset?: string;
      cover_video_id?: number | null;
      visibility?: PlaylistVisibility;
    }
  ): Promise<Playlist> {
    return request<Playlist>(`/api/playlists/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
  },

  syncPlaylist(id: number): Promise<Playlist> {
    return request<Playlist>(`/api/playlists/${id}/sync`, { method: "POST" });
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

  addUrlToPlaylist(playlistId: number, url: string): Promise<PlaylistDetail> {
    return request<PlaylistDetail>(`/api/playlists/${playlistId}/items`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
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

  reorderPlaylists(playlistIds: number[]): Promise<Playlist[]> {
    return request<Playlist[]>("/api/playlists/reorder", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ playlist_ids: playlistIds }),
    });
  },

  uploadPlaylistCover(id: number, file: File): Promise<Playlist> {
    const form = new FormData();
    form.append("file", file);
    return request<Playlist>(`/api/playlists/${id}/thumbnail`, {
      method: "POST",
      body: form,
    });
  },

  importPlaylist(
    url: string,
    quality_preset: string,
    opts: {
      name?: string;
      entries?: string[];
      subscribe?: boolean;
      visibility?: PlaylistVisibility;
    } = {}
  ): Promise<Playlist> {
    return request<Playlist>("/api/playlists/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url,
        quality_preset,
        name: opts.name,
        entries: opts.entries,
        subscribe: opts.subscribe ?? false,
        visibility: opts.visibility,
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
  ): Promise<ApiResponse<"/api/playlists/estimate", "post">> {
    return request("/api/playlists/estimate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ urls }),
    });
  },
};
