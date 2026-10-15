/**
 * IndexedDB + Cache Storage layout for offline videos. Shared by the app and
 * the service worker (bundled into sw.js), so keep this free of DOM / React.
 */
import type { Video } from "../types";

export const DB_NAME = "horde-offline";
export const DB_VERSION = 1;
export const ITEMS_STORE = "items";
export const PENDING_PROGRESS_STORE = "pendingProgress";

/** Video bytes, stored as fixed-size chunks so downloads can resume. */
export const MEDIA_CACHE = "horde-offline-media-v1";
/** Thumbnails / subtitles keyed by their real API URL. */
export const EXTRAS_CACHE = "horde-offline-extras-v1";

export const CHUNK_SIZE = 4 * 1024 * 1024;

export type OfflineStatus =
  "queued" | "downloading" | "paused" | "complete" | "error";

export interface OfflineSponsorSegment {
  startSec: number;
  endSec: number;
  category: string;
}

export interface OfflineItem {
  /**
   * Library video id. Device-destination download jobs (not in the library)
   * use `-jobId` so they share the same Watch / player / stream URL paths.
   */
  videoId: number;
  video: Video;
  status: OfflineStatus;
  /** Server URL the bytes are fetched from (supports HTTP Range). */
  sourceUrl: string;
  contentType: string;
  /** 0 until the first ranged response reports the full size. */
  totalBytes: number;
  chunkSize: number;
  /** Count of contiguous chunks already stored, starting at 0. */
  chunksDone: number;
  /** External thumbnail for device jobs (stored as /api/thumbnails/-id). */
  thumbnailSource?: string | null;
  /** Extra URLs stored in EXTRAS_CACHE (thumbnail, subtitles). */
  extras: string[];
  sponsorSegments?: OfflineSponsorSegment[] | null;
  createdAt: number;
  completedAt?: number;
  error?: string | null;
}

export interface PendingProgress {
  videoId: number;
  positionSec: number;
  at: number;
}

export function chunkUrl(videoId: number, index: number): string {
  return `/__offline__/chunk/${videoId}/${index}`;
}

export function chunkCount(
  item: Pick<OfflineItem, "totalBytes" | "chunkSize">
): number {
  if (!item.totalBytes) return 0;
  return Math.ceil(item.totalBytes / item.chunkSize);
}

export function bytesDone(item: OfflineItem): number {
  if (item.status === "complete") return item.totalBytes;
  return Math.min(item.totalBytes, item.chunksDone * item.chunkSize);
}

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(ITEMS_STORE)) {
        db.createObjectStore(ITEMS_STORE, { keyPath: "videoId" });
      }
      if (!db.objectStoreNames.contains(PENDING_PROGRESS_STORE)) {
        db.createObjectStore(PENDING_PROGRESS_STORE, { keyPath: "videoId" });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // Another tab upgrading the schema: let it, reopen lazily next time.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
  });
  return dbPromise;
}

function wrap<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function store(name: string, mode: IDBTransactionMode) {
  const db = await openDb();
  return db.transaction(name, mode).objectStore(name);
}

export async function getItem(
  videoId: number
): Promise<OfflineItem | undefined> {
  return wrap((await store(ITEMS_STORE, "readonly")).get(videoId));
}

export async function getAllItems(): Promise<OfflineItem[]> {
  return wrap((await store(ITEMS_STORE, "readonly")).getAll());
}

export async function putItem(item: OfflineItem): Promise<void> {
  await wrap((await store(ITEMS_STORE, "readwrite")).put(item));
}

export async function deleteItem(videoId: number): Promise<void> {
  await wrap((await store(ITEMS_STORE, "readwrite")).delete(videoId));
}

export async function putPendingProgress(p: PendingProgress): Promise<void> {
  await wrap((await store(PENDING_PROGRESS_STORE, "readwrite")).put(p));
}

export async function getAllPendingProgress(): Promise<PendingProgress[]> {
  return wrap((await store(PENDING_PROGRESS_STORE, "readonly")).getAll());
}

export async function deletePendingProgress(videoId: number): Promise<void> {
  await wrap(
    (await store(PENDING_PROGRESS_STORE, "readwrite")).delete(videoId)
  );
}

/** `/api/videos/12/stream` → 12, `/api/videos/-3/stream` → -3. */
export function streamVideoId(pathname: string): number | null {
  const m = /^\/api\/videos\/(-?\d+)\/stream$/.exec(pathname);
  return m ? Number(m[1]) : null;
}
