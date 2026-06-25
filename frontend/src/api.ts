import type {
  ChannelStat,
  DownloadJob,
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
}

export const api = {
  listVideos(params: LibraryQuery = {}): Promise<Video[]> {
    const qs = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
      if (v) qs.set(k, v);
    });
    return request<Video[]>(`/api/videos?${qs.toString()}`);
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

  listChannels(): Promise<ChannelStat[]> {
    return request<ChannelStat[]>("/api/channels");
  },

  listTags(): Promise<string[]> {
    return request<string[]>("/api/tags");
  },

  listReview(): Promise<Video[]> {
    return request<Video[]>("/api/review");
  },

  listPresets(): Promise<string[]> {
    return request<string[]>("/api/downloads/presets");
  },

  createDownload(url: string, quality_preset: string): Promise<DownloadJob> {
    return request<DownloadJob>("/api/downloads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, quality_preset }),
    });
  },

  listJobs(): Promise<DownloadJob[]> {
    return request<DownloadJob[]>("/api/downloads");
  },
};

export function thumbnailUrl(video: Video): string | null {
  return video.has_thumbnail ? `/api/thumbnails/${video.id}` : null;
}

export function streamUrl(id: number): string {
  return `/api/videos/${id}/stream`;
}
