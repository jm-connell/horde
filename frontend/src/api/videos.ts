import type {
  MediaToken,
  NextPart,
  HistoryStats,
  HistoryStatsRange,
  TagStat,
  Video,
  VideoUpdate,
  SpriteMeta,
} from "../types";
import type { ApiResponse } from "./typed";
import {
  ApiError,
  collectPages,
  isNetworkFailure,
  type Page,
  PAGE_SIZE,
  type ReadOptions,
  request,
  send,
} from "./client";
import {
  type DeleteResult,
  TRASH_ENTRY_HEADER,
  TRASH_ENTRIES_HEADER,
  parseTrashEntryIds,
} from "./trash";
import { getItem as getOfflineItem } from "../offline/db";
import { deviceAccounts } from "../offline/accounts";
import { deviceResume } from "../offline/resume";
import { pendingProgress } from "../offline/pendingProgress";
import { unlockedAccountId } from "../offline/unlock";

/** Event the offline manager listens for to keep resume positions current. */
export const OFFLINE_PROGRESS_EVENT = "horde:offline-progress";

function notifyOfflineProgress(videoId: number, positionSec: number): void {
  window.dispatchEvent(
    new CustomEvent(OFFLINE_PROGRESS_EVENT, {
      detail: { videoId, positionSec },
    })
  );
}

/** A video saved on this device, with this account's place in it. */
async function offlineVideo(id: number): Promise<Video> {
  const item = await getOfflineItem(id).catch(() => undefined);
  // Another account's private download is not here as far as this one knows.
  if (!item || !(await deviceAccounts.canSee(item))) {
    throw new ApiError("Video not found", { status: 404 });
  }
  return deviceResume.offline(item.video);
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
  signal?: AbortSignal;
}

export const videosApi = {
  /** The channel's next upload when it clearly continues this video's series. */
  getNextPart(videoId: number): Promise<NextPart> {
    return request<NextPart>(`/api/videos/${videoId}/next-part`);
  },

  getMediaToken(videoId: number): Promise<MediaToken> {
    return request<MediaToken>(`/api/videos/${videoId}/media-token`);
  },

  /** One page of the library. `listVideos` walks them all. */
  listVideosPage(
    params: LibraryQuery & {
      limit?: number;
      cursor?: string | null;
      include_total?: boolean;
    } = {}
  ): Promise<Page<Video>> {
    const { signal, ...query } = params;
    const qs = new URLSearchParams();
    Object.entries(query).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
    });
    return request<Page<Video>>(
      `/api/videos?${qs.toString()}`,
      signal ? { signal } : undefined
    );
  },

  /**
   * Every matching video. Pages are fetched back to back; `onPage` receives the
   * list so far after each page but the last (see `collectPages`).
   */
  listVideos(
    params: LibraryQuery = {},
    onPage?: (soFar: Video[]) => void
  ): Promise<Video[]> {
    return collectPages(
      (cursor) =>
        videosApi.listVideosPage({ ...params, limit: PAGE_SIZE, cursor }),
      onPage
    );
  },

  /** Save the position; `finished` records that the video played to its end. */
  async saveProgress(
    id: number,
    positionSec: number,
    finished = false
  ): Promise<void> {
    notifyOfflineProgress(id, positionSec);
    // Offline-only device downloads have no server record.
    if (id < 0) return;
    // Acting as an account unlocked on this device: the session cookie may be
    // somebody else's, so never send live. The save waits for its owner.
    if (unlockedAccountId() !== null) {
      await pendingProgress
        .add(id, positionSec, finished)
        .catch(() => undefined);
      return;
    }
    try {
      await request<void>(`/api/videos/${id}/progress`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          finished
            ? { position_sec: positionSec, finished }
            : { position_sec: positionSec }
        ),
        // Sent as the page is hidden or closed too: let it outlive the page.
        keepalive: true,
      });
    } catch (err) {
      if (!isNetworkFailure(err)) throw err;
      // Sync when the connection is back (offline/manager flushes these),
      // for the account that is signed in now.
      await pendingProgress
        .add(id, positionSec, finished)
        .catch(() => undefined);
    }
  },

  /**
   * Progress PATCH for a save made earlier (queued while offline). `at` is
   * when it was made: the server keeps it only if nothing newer was saved
   * since, on any device.
   */
  syncProgress(
    id: number,
    positionSec: number,
    at: number,
    finished = false
  ): Promise<void> {
    return request<void>(`/api/videos/${id}/progress`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        position_sec: positionSec,
        watched_at: new Date(at).toISOString(),
        ...(finished ? { finished } : {}),
      }),
    });
  },

  /**
   * The video with the signed-in account's resume position (see
   * offline/resume). Falls back to the downloaded copy when offline or
   * unreachable.
   */
  async getVideo(id: number, opts?: ReadOptions): Promise<Video> {
    if (id < 0) return offlineVideo(id);
    let video: Video;
    try {
      video = await request<Video>(`/api/videos/${id}`, opts);
    } catch (err) {
      if (!isNetworkFailure(err)) throw err;
      const local = await getOfflineItem(id).catch(() => undefined);
      if (local && (await deviceAccounts.canSee(local))) {
        return deviceResume.offline(local.video);
      }
      throw err;
    }
    return deviceResume.online(video);
  },

  getRelatedVideos(
    id: number,
    limit = 8,
    offset = 0,
    opts?: ReadOptions
  ): Promise<Video[]> {
    const qs = new URLSearchParams({
      limit: String(limit),
      offset: String(offset),
    });
    return request<Video[]>(`/api/videos/${id}/related?${qs.toString()}`, opts);
  },

  updateVideo(id: number, payload: VideoUpdate): Promise<Video> {
    return request<Video>(`/api/videos/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  },

  async deleteVideo(id: number, deleteFile = false): Promise<DeleteResult> {
    const resp = await send(`/api/videos/${id}?delete_file=${deleteFile}`, {
      method: "DELETE",
    });
    return {
      trashEntryIds: parseTrashEntryIds(resp.headers.get(TRASH_ENTRY_HEADER)),
    };
  },

  /** A partial failure throws; `trashEntryIdsOfError` lists the ones that moved. */
  async bulkDeleteVideos(
    ids: number[],
    deleteFiles = false
  ): Promise<DeleteResult> {
    const resp = await send("/api/videos/bulk-delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ video_ids: ids, delete_files: deleteFiles }),
    });
    return {
      trashEntryIds: parseTrashEntryIds(resp.headers.get(TRASH_ENTRIES_HEADER)),
    };
  },

  /** The signed-in account's watch stats, counted in the browser's time zone. */
  historyStats(
    range: HistoryStatsRange,
    opts?: ReadOptions
  ): Promise<HistoryStats> {
    const params = new URLSearchParams({ range });
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz) params.set("tz", tz);
    return request<HistoryStats>(`/api/history/stats?${params}`, opts);
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
  ): Promise<ApiResponse<"/api/videos/refresh-metadata", "post">> {
    return request("/api/videos/refresh-metadata", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        video_ids: videoIds ?? [],
        fields: fields ?? [],
      }),
    });
  },

  getMetadataSyncStatus(
    opts?: ReadOptions
  ): Promise<ApiResponse<"/api/videos/refresh-metadata/status", "get">> {
    return request("/api/videos/refresh-metadata/status", opts);
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
  ): Promise<
    ApiResponse<"/api/videos/{video_id}/thumbnail/candidates", "post">
  > {
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

  ensureSprites(
    id: number
  ): Promise<ApiResponse<"/api/videos/{video_id}/sprites/generate", "post">> {
    return request(`/api/videos/${id}/sprites/generate`, { method: "POST" });
  },

  listTags(): Promise<string[]> {
    return collectPages((cursor) => {
      const qs = new URLSearchParams({ limit: "5000" });
      if (cursor) qs.set("cursor", cursor);
      return request<Page<string>>(`/api/tags?${qs}`);
    });
  },

  tagStats(channel?: string, opts?: ReadOptions): Promise<TagStat[]> {
    return collectPages((cursor) => {
      const qs = new URLSearchParams({ limit: "2000" });
      if (channel) qs.set("channel", channel);
      if (cursor) qs.set("cursor", cursor);
      return request<Page<TagStat>>(`/api/tags/stats?${qs}`, opts);
    });
  },
};
