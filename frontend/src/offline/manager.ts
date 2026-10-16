/**
 * In-app offline downloads (YouTube-style). Videos are fetched from the server
 * in CHUNK_SIZE Range requests and stored in Cache Storage, so a dropped
 * connection resumes from the last stored chunk instead of starting over. The
 * service worker serves completed items back to the player.
 *
 * One download runs at a time; the rest wait in a FIFO queue. Downloads pause
 * automatically while the app is in offline mode and resume afterwards.
 */
import {
  checkOriginalSupport,
  chooseRendition,
  codecLabel,
} from "../utils/playbackRendition";
import {
  ApiError,
  OFFLINE_PROGRESS_EVENT,
  api,
  listThumbnailUrl,
  streamUrl,
  subtitleUrl,
  thumbnailUrl,
} from "../api";
import { SPONSOR_BLOCK_CATEGORIES } from "../sponsorBlock";
import { extractYouTubeId } from "../hooks/useSponsorBlock";
import type { DownloadJob, Video } from "../types";
import { connectivity } from "./connectivity";
import {
  CHUNK_SIZE,
  EXTRAS_CACHE,
  MEDIA_CACHE,
  chunkCount,
  chunkUrl,
  deleteItem,
  getAllItems,
  putItem,
  type OfflineItem,
  type OfflineSponsorSegment,
} from "./db";
import { classifySendFailure, pendingProgress } from "./pendingProgress";
import { contentRangeTotal } from "./ranges";
import { isAppleWebkit } from "../utils/playbackRendition";
import {
  isQuotaError,
  OFFLINE_QUOTA_EVENT,
  quotaMessage,
  StorageQuotaError,
  type OfflineQuotaDetail,
} from "./quota";

export interface OfflineSnapshot {
  items: OfflineItem[];
  byId: ReadonlyMap<number, OfflineItem>;
  /** Live byte counts for the active download (finer than chunk progress). */
  liveBytes: ReadonlyMap<number, number>;
  ready: boolean;
  /** Offline storage is unavailable (no Cache API / IndexedDB, e.g. http). */
  unsupported: boolean;
}

const MAX_CHUNK_RETRIES = 4;

export const UNSUPPORTED_MESSAGE =
  "Offline downloads need Horde to be opened over HTTPS (or localhost)";
const EMIT_THROTTLE_MS = 250;

class AbortReason extends Error {
  constructor(public kind: "pause" | "remove" | "offline") {
    super(kind);
  }
}

function offlineSupported(): boolean {
  return (
    typeof indexedDB !== "undefined" &&
    typeof caches !== "undefined" &&
    typeof window !== "undefined" &&
    window.isSecureContext !== false
  );
}

export function videoFromJob(job: DownloadJob): Video {
  return {
    id: -job.id,
    title: (job.title_override || job.title || "Video").trim(),
    channel: job.channel_override || job.channel,
    channel_url: null,
    tags: [],
    ai_tags: [],
    user_tags: [],
    description: null,
    notes: null,
    source_url: job.url,
    has_thumbnail: Boolean(job.thumbnail_url),
    has_sprites: false,
    subtitles: [],
    file_path: job.device_file_path ?? "",
    duration_sec: null,
    file_size: job.file_size,
    width_px: null,
    height_px: job.height_px ?? null,
    frame_rate: null,
    view_count: null,
    channel_subscriber_count: null,
    published_at: null,
    added_at: job.created_at,
    last_position_sec: 0,
    last_watched_at: null,
    needs_review: false,
    platform: null,
    status: "ready",
    metadata_synced_at: null,
    source_title: null,
    source_description: null,
    title_is_custom: false,
    description_is_custom: false,
    subtitles_pending: false,
    chapters: [],
    has_compat: false,
    is_hdr: false,
    processing_summary: false,
    processing_sprites: false,
    processing_chapters: false,
  };
}

class OfflineManager {
  private snapshot: OfflineSnapshot = {
    items: [],
    byId: new Map(),
    liveBytes: new Map(),
    ready: false,
    unsupported: !offlineSupported(),
  };
  private items = new Map<number, OfflineItem>();
  private live = new Map<number, number>();
  private listeners = new Set<() => void>();
  private active: { videoId: number; ctrl: AbortController } | null = null;
  private emitTimer: ReturnType<typeof setTimeout> | null = null;
  private initPromise: Promise<void> | null = null;
  private persistRequested = false;

  getSnapshot = (): OfflineSnapshot => this.snapshot;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  init(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      if (this.snapshot.unsupported) {
        this.snapshot = { ...this.snapshot, ready: true };
        this.notify();
        return;
      }
      try {
        for (const item of await getAllItems()) {
          // A download interrupted by closing the app resumes from its last
          // stored chunk.
          if (item.status === "downloading") item.status = "queued";
          this.items.set(item.videoId, item);
        }
      } catch {
        this.snapshot = { ...this.snapshot, unsupported: true };
      }
      this.emit(true);
      connectivity.subscribe(() => this.onConnectivity());
      window.addEventListener(OFFLINE_PROGRESS_EVENT, (e) => {
        const d = (e as CustomEvent<{ videoId: number; positionSec: number }>)
          .detail;
        this.recordProgress(d.videoId, d.positionSec);
      });
      this.onConnectivity();
    })();
    return this.initPromise;
  }

  /** Queue a library video for offline viewing. */
  async download(video: Video): Promise<void> {
    await this.init();
    if (this.snapshot.unsupported) throw new Error(UNSUPPORTED_MESSAGE);
    const existing = this.items.get(video.id);
    if (existing && existing.status !== "error") {
      if (existing.status === "paused") this.resume(video.id);
      return;
    }
    // Store the file this device can actually decode (the service worker
    // answers /stream for this id regardless of ?rendition).
    const choice = chooseRendition(await checkOriginalSupport(video), video);
    if (choice.rendition === null) {
      api.requestCompat(video.id).catch(() => undefined);
      throw new Error(
        `This device can’t play ${codecLabel(video)} video. Horde is making an H.264 copy — save it for offline again once that finishes.`
      );
    }
    await this.enqueue({
      videoId: video.id,
      video,
      sourceUrl: streamUrl(video.id, choice.rendition),
    });
  }

  /** Pull a finished device-destination job into offline storage. */
  async downloadJob(job: DownloadJob): Promise<void> {
    await this.init();
    if (this.snapshot.unsupported) throw new Error(UNSUPPORTED_MESSAGE);
    const videoId = -job.id;
    const existing = this.items.get(videoId);
    if (existing && existing.status !== "error") {
      if (existing.status === "paused") this.resume(videoId);
      return;
    }
    await this.enqueue({
      videoId,
      video: videoFromJob(job),
      sourceUrl: `/api/downloads/${job.id}/file`,
      thumbnailSource: job.thumbnail_url,
    });
  }

  pause(videoId: number): void {
    const item = this.items.get(videoId);
    if (!item || item.status === "complete") return;
    if (this.active?.videoId === videoId) {
      this.active.ctrl.abort(new AbortReason("pause"));
    }
    void this.save({ ...item, status: "paused" });
  }

  resume(videoId: number): void {
    const item = this.items.get(videoId);
    if (!item || item.status === "complete") return;
    void this.save({ ...item, status: "queued", error: null }).then(() =>
      this.pump()
    );
  }

  async remove(videoId: number): Promise<void> {
    const item = this.items.get(videoId);
    if (!item) return;
    if (this.active?.videoId === videoId) {
      this.active.ctrl.abort(new AbortReason("remove"));
    }
    this.items.delete(videoId);
    this.live.delete(videoId);
    this.emit(true);
    await deleteItem(videoId).catch(() => undefined);
    await this.deleteStoredData(item);
  }

  /** Refresh stored metadata (e.g. title edits) for a downloaded video. */
  updateVideo(video: Video): void {
    const item = this.items.get(video.id);
    if (!item) return;
    void this.save({ ...item, video: { ...item.video, ...video } });
  }

  private async enqueue(seed: {
    videoId: number;
    video: Video;
    sourceUrl: string;
    thumbnailSource?: string | null;
  }): Promise<void> {
    const old = this.items.get(seed.videoId);
    if (old) await this.deleteStoredData(old);
    const item: OfflineItem = {
      ...seed,
      status: "queued",
      contentType: "video/mp4",
      totalBytes: 0,
      chunkSize: CHUNK_SIZE,
      chunksDone: 0,
      extras: [],
      sponsorSegments: null,
      createdAt: Date.now(),
      error: null,
    };
    await this.save(item);
    this.requestPersistence();
    this.pump();
  }

  private onConnectivity(): void {
    const { status } = connectivity.getState();
    if (status === "offline") {
      this.active?.ctrl.abort(new AbortReason("offline"));
      return;
    }
    if (status === "online" || status === "slow") {
      void this.flushPendingProgress();
    }
    this.pump();
  }

  /** Keep the downloaded copy's resume point current (used offline). */
  private recordProgress(videoId: number, positionSec: number): void {
    const item = this.items.get(videoId);
    if (!item) return;
    const video = {
      ...item.video,
      last_position_sec: positionSec,
      last_watched_at: new Date().toISOString(),
    };
    this.items.set(videoId, { ...item, video });
    // Persist without re-rendering every list on each periodic save.
    void putItem({ ...item, video }).catch(() => undefined);
  }

  /**
   * Send progress saved while offline, for the account the server says is
   * signed in (other accounts' saves wait for them; see pendingProgress).
   */
  flushPendingProgress(): Promise<void> {
    return pendingProgress.flush({
      whoAmI: async () => {
        const state = await api.getAuthState();
        return state.authenticated && state.user ? state.user.id : null;
      },
      send: (videoId, positionSec) => api.syncProgress(videoId, positionSec),
      classify: (err) =>
        classifySendFailure(err instanceof ApiError ? err.status : null),
    });
  }

  private pump(): void {
    if (this.active || connectivity.offlineMode) return;
    const next = [...this.items.values()]
      .filter((i) => i.status === "queued")
      .sort((a, b) => a.createdAt - b.createdAt)[0];
    if (!next) return;
    const ctrl = new AbortController();
    this.active = { videoId: next.videoId, ctrl };
    void this.run(next.videoId, ctrl.signal).finally(() => {
      if (this.active?.ctrl === ctrl) this.active = null;
      this.live.delete(next.videoId);
      this.emit(true);
      this.pump();
    });
  }

  private async run(videoId: number, signal: AbortSignal): Promise<void> {
    let item = this.items.get(videoId);
    if (!item) return;
    try {
      item = await this.patch(
        videoId,
        { status: "downloading", error: null },
        signal
      );
      if (item.totalBytes === 0) item = await this.prepare(item, signal);
      item = await this.fetchChunks(item, signal);
      item = await this.fetchExtras(item, signal);
      await this.patch(
        videoId,
        { status: "complete", completedAt: Date.now() },
        signal
      );
    } catch (err) {
      const current = this.items.get(videoId);
      if (!current) return; // removed
      const reason = signal.reason;
      if (reason instanceof AbortReason) {
        if (reason.kind === "offline") {
          await this.save({ ...current, status: "queued" });
        }
        // pause/remove already updated state.
        return;
      }
      if (connectivity.offlineMode) {
        await this.save({ ...current, status: "queued" });
        return;
      }
      if (isQuotaError(err)) {
        await this.failForQuota(current);
        return;
      }
      await this.save({
        ...current,
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Storage is full: drop the partial chunks (they are useless without the
   * rest and keep eating the space the user needs), mark the item failed so it
   * can be retried, and tell the UI how much room is left.
   */
  private async failForQuota(item: OfflineItem): Promise<void> {
    await this.deleteStoredData(item);
    const est = await navigator.storage?.estimate?.().catch(() => null);
    const freeBytes = est?.quota != null ? est.quota - (est.usage ?? 0) : null;
    const message = quotaMessage(item.video.title, freeBytes);
    try {
      await this.save({
        ...item,
        status: "error",
        error: message,
        chunksDone: 0,
        extras: [],
      });
    } catch (err) {
      // The metadata write can fail for the same reason; the in-memory state
      // already shows the error and the next init resets the half-written row.
      console.warn("Could not persist offline quota failure", err);
    }
    window.dispatchEvent(
      new CustomEvent<OfflineQuotaDetail>(OFFLINE_QUOTA_EVENT, {
        detail: { videoId: item.videoId, title: item.video.title, freeBytes },
      })
    );
  }

  /**
   * Safari/iOS cannot play some stored originals until the server rewrites them
   * (GET /stream no longer does that). Ask, then wait, so the offline copy is the
   * playable file. Failures fall through: the download still proceeds.
   */
  private async ensureSafariReady(
    videoId: number,
    signal: AbortSignal
  ): Promise<void> {
    if (videoId <= 0 || !isAppleWebkit()) return;
    try {
      let state = await api.requestSafariPrep(videoId);
      while (state.status === "queued" || state.status === "running") {
        if (signal.aborted) return;
        await new Promise((r) => window.setTimeout(r, 2000));
        state = await api.getSafariPrep(videoId);
      }
    } catch {
      // Best effort; the original is downloaded as stored.
    }
  }

  /** First request: learn the size/type. */
  private async prepare(
    item: OfflineItem,
    signal: AbortSignal
  ): Promise<OfflineItem> {
    let video = item.video;
    if (item.videoId > 0) {
      // List responses can be compact; fetch full metadata (chapters, subs).
      video = await api.getVideo(item.videoId).catch(() => item.video);
    }
    await this.ensureSafariReady(item.videoId, signal);
    const resp = await fetch(item.sourceUrl, {
      headers: { Range: "bytes=0-0" },
      cache: "no-store",
      signal,
    });
    if (resp.status !== 206) {
      await resp.body?.cancel().catch(() => undefined);
      throw new Error(
        resp.ok
          ? "Server does not support resumable downloads"
          : `Download failed (${resp.status})`
      );
    }
    const total = contentRangeTotal(resp.headers.get("content-range"));
    await resp.arrayBuffer().catch(() => undefined);
    if (!total) throw new Error("Unknown file size");
    await this.ensureSpace(total);
    const contentType =
      resp.headers.get("content-type")?.split(";")[0] || "video/mp4";
    return this.patch(
      item.videoId,
      { video, totalBytes: total, contentType },
      signal
    );
  }

  private async ensureSpace(bytes: number): Promise<void> {
    const est = await navigator.storage?.estimate?.().catch(() => null);
    if (!est || !est.quota) return;
    const free = est.quota - (est.usage ?? 0);
    if (free < bytes * 1.02) {
      throw new StorageQuotaError(bytes, free);
    }
  }

  private async fetchChunks(
    item: OfflineItem,
    signal: AbortSignal
  ): Promise<OfflineItem> {
    const cache = await caches.open(MEDIA_CACHE);
    const count = chunkCount(item);
    for (let i = item.chunksDone; i < count; i++) {
      const start = i * item.chunkSize;
      const end = Math.min(item.totalBytes, start + item.chunkSize) - 1;
      const blob = await this.fetchChunkWithRetry(item, start, end, signal);
      await cache.put(
        chunkUrl(item.videoId, i),
        new Response(blob, {
          headers: { "Content-Type": "application/octet-stream" },
        })
      );
      item = await this.patch(item.videoId, { chunksDone: i + 1 }, signal);
    }
    return item;
  }

  private async fetchChunkWithRetry(
    item: OfflineItem,
    start: number,
    end: number,
    signal: AbortSignal
  ): Promise<Blob> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < MAX_CHUNK_RETRIES; attempt++) {
      if (signal.aborted) throw signal.reason;
      try {
        return await this.fetchChunk(item, start, end, signal);
      } catch (err) {
        if (signal.aborted || err instanceof FileChangedError) throw err;
        lastErr = err;
        await sleep(1000 * 2 ** attempt, signal);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error("Download failed");
  }

  private async fetchChunk(
    item: OfflineItem,
    start: number,
    end: number,
    signal: AbortSignal
  ): Promise<Blob> {
    const resp = await fetch(item.sourceUrl, {
      headers: { Range: `bytes=${start}-${end}` },
      cache: "no-store",
      signal,
    });
    if (resp.status !== 206) {
      await resp.body?.cancel().catch(() => undefined);
      throw new Error(`Download failed (${resp.status})`);
    }
    const total = contentRangeTotal(resp.headers.get("content-range"));
    if (total !== item.totalBytes) {
      await resp.body?.cancel().catch(() => undefined);
      throw new FileChangedError();
    }
    const expected = end - start + 1;
    const reader = resp.body?.getReader();
    if (!reader) return resp.blob();
    const parts: Uint8Array[] = [];
    let got = 0;
    const base = item.chunksDone * item.chunkSize;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      got += value.byteLength;
      this.live.set(item.videoId, base + got);
      this.emit();
    }
    if (got !== expected) throw new Error("Incomplete chunk");
    return new Blob(parts as BlobPart[]);
  }

  private async fetchExtras(
    item: OfflineItem,
    signal: AbortSignal
  ): Promise<OfflineItem> {
    const cache = await caches.open(EXTRAS_CACHE);
    const extras: string[] = [];
    const store = async (url: string, source: string | Request = url) => {
      try {
        const resp = await fetch(source, { signal });
        // Opaque (cross-origin thumbnail) responses are fine for <img>.
        if (!resp.ok && resp.type !== "opaque") return;
        await cache.put(url, resp);
        extras.push(url);
      } catch (err) {
        // Extras are best-effort, but a full disk must stop the download.
        if (isQuotaError(err)) throw err;
      }
    };
    const v = item.video;
    if (item.videoId > 0) {
      const full = thumbnailUrl(v);
      if (full) {
        await store(full);
        await store(listThumbnailUrl(v.id));
      }
      for (const track of v.subtitles ?? []) {
        await store(subtitleUrl(v.id, track.lang));
      }
    } else {
      const thumb = item.thumbnailSource;
      if (thumb) {
        await store(
          `/api/thumbnails/${item.videoId}`,
          new Request(thumb, { mode: "no-cors" })
        );
      }
    }
    const sponsorSegments = await fetchSponsorSegments(v, signal);
    return this.patch(item.videoId, { extras, sponsorSegments }, signal);
  }

  private async deleteStoredData(item: OfflineItem): Promise<void> {
    try {
      const media = await caches.open(MEDIA_CACHE);
      const count = Math.max(chunkCount(item), item.chunksDone + 1);
      await Promise.all(
        Array.from({ length: count }, (_, i) =>
          media.delete(chunkUrl(item.videoId, i))
        )
      );
      const extras = await caches.open(EXTRAS_CACHE);
      await Promise.all(item.extras.map((u) => extras.delete(u)));
    } catch {
      // Storage already gone.
    }
  }

  private requestPersistence(): void {
    if (this.persistRequested) return;
    this.persistRequested = true;
    // Ask the browser not to evict downloads under storage pressure.
    void navigator.storage?.persist?.().catch(() => false);
  }

  /**
   * Merge download progress into the *current* record. Throws once the
   * download was paused/removed/interrupted so a stale copy can never
   * overwrite the user's change.
   */
  private async patch(
    videoId: number,
    patch: Partial<OfflineItem>,
    signal: AbortSignal
  ): Promise<OfflineItem> {
    if (signal.aborted) throw signal.reason;
    const current = this.items.get(videoId);
    if (!current) throw new AbortReason("remove");
    return this.save({ ...current, ...patch });
  }

  private async save(item: OfflineItem): Promise<OfflineItem> {
    // A removed item must not be resurrected by an in-flight download.
    const current = this.items.get(item.videoId);
    if (!current && item.status !== "queued") return item;
    this.items.set(item.videoId, item);
    this.emit(true);
    await putItem(item);
    return item;
  }

  private emit(immediate = false): void {
    if (immediate) {
      if (this.emitTimer) clearTimeout(this.emitTimer);
      this.emitTimer = null;
      this.publish();
      return;
    }
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      this.publish();
    }, EMIT_THROTTLE_MS);
  }

  private publish(): void {
    const items = [...this.items.values()].sort(
      (a, b) => b.createdAt - a.createdAt
    );
    this.snapshot = {
      ...this.snapshot,
      items,
      byId: new Map(this.items),
      liveBytes: new Map(this.live),
      ready: this.initPromise !== null,
    };
    this.notify();
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }
}

class FileChangedError extends Error {
  constructor() {
    super("The file changed on the server; retry the download");
  }
}

async function fetchSponsorSegments(
  video: Video,
  signal: AbortSignal
): Promise<OfflineSponsorSegment[] | null> {
  const ytId = extractYouTubeId(video.source_url, video.file_path);
  if (!ytId) return null;
  const cats = encodeURIComponent(
    JSON.stringify(SPONSOR_BLOCK_CATEGORIES.map((c) => c.id))
  );
  try {
    const resp = await fetch(
      `https://sponsor.ajay.app/api/skipSegments?videoID=${ytId}&categories=${cats}`,
      { signal }
    );
    // 404 = no segments for this video.
    if (resp.status === 404) return [];
    if (!resp.ok) return null;
    const data = (await resp.json()) as {
      segment: [number, number];
      category: string;
    }[];
    if (!Array.isArray(data)) return null;
    return data.map((s) => ({
      startSec: s.segment[0],
      endSec: s.segment[1],
      category: s.category,
    }));
  } catch {
    return null;
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(signal.reason);
      },
      { once: true }
    );
  });
}

export const offlineManager = new OfflineManager();
