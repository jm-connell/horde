/**
 * IndexedDB + Cache Storage layout for offline videos. Shared by the app and
 * the service worker (bundled into sw.js), so keep this free of DOM / React.
 */
import type { Permission, Video } from "../types";

export const DB_NAME = "horde-offline";
/**
 * 2: pending progress is keyed by [owner, videoId]. The un-owned records of
 * version 1 are dropped on upgrade (see `openDb`).
 * 3: resume positions of saved videos are kept per account in their own store,
 * keyed by [owner, videoId]; the one un-owned position each item carried is
 * dropped on upgrade.
 * 4: the accounts that have signed in on this device (who shares their
 * downloads, and the check value for unlocking private ones offline). Saved
 * videos get an `owner`; the ones saved before have none and stay shared.
 */
export const DB_VERSION = 4;
export const ITEMS_STORE = "items";
export const PENDING_PROGRESS_STORE = "pendingProgress";
export const RESUME_POSITIONS_STORE = "resumePositions";
export const DEVICE_ACCOUNTS_STORE = "deviceAccounts";

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
  /**
   * The video's metadata, shared by everyone using this device. Its watch
   * fields (`last_position_sec`, `last_watched_at`) are always empty: resume
   * positions belong to an account and live in RESUME_POSITIONS_STORE.
   */
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
  /**
   * Id of the account that saved it on this device. Missing on videos saved
   * before accounts could keep their downloads private: those are shared.
   */
  owner?: number;
  /** That account's username when it saved the video (shown if it is unknown). */
  ownerName?: string;
}

/**
 * A way to check a password without keeping it: PBKDF2-SHA256 with a random
 * salt. Kept on this device only, to unlock an account's private downloads
 * with no connection (see `offline/accounts.ts`).
 */
export interface PasswordVerifier {
  /** Base64. */
  salt: string;
  /** Base64 of the derived key. */
  hash: string;
  iterations: number;
}

/** An account that has signed in on this device. */
export interface DeviceAccount {
  userId: number;
  username: string;
  /** Whether other accounts on this device may see its downloads. */
  shareDownloads: boolean;
  /** Only while it does not share; kept across sign-outs. */
  verifier?: PasswordVerifier;
  /** What the account may do, so it can be acted as offline once unlocked. */
  isAdmin: boolean;
  permissions: Permission[];
}

/** One account's place in one video, as recorded on this device. */
export interface OwnedPosition {
  /** Id of the account that was signed in when it was saved. */
  owner: number;
  videoId: number;
  positionSec: number;
  /** When it was reached (ms since the epoch, this device's clock). */
  at: number;
}

/** A progress save that could not reach the server, waiting to be sent. */
export type PendingProgress = OwnedPosition;

/** Where an account is in a video saved on this device (used offline). */
export type ResumePosition = OwnedPosition;

/** The item with the device-wide watch fields cleared (see `OfflineItem.video`). */
export function withoutWatchState(item: OfflineItem): OfflineItem {
  if (item.video.last_position_sec === 0 && item.video.last_watched_at === null)
    return item;
  return {
    ...item,
    video: { ...item.video, last_position_sec: 0, last_watched_at: null },
  };
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

/** Bring the database from `oldVersion` (0: new) to DB_VERSION. */
export function upgradeDb(
  db: IDBDatabase,
  oldVersion: number,
  transaction: IDBTransaction | null
): void {
  if (!db.objectStoreNames.contains(ITEMS_STORE)) {
    db.createObjectStore(ITEMS_STORE, { keyPath: "videoId" });
  }
  // Version 1 queued progress without saying whose it was. Nobody can tell
  // any more, and sending it as whoever signs in next would write one
  // account's position into another's history: drop it.
  if (oldVersion < 2 && db.objectStoreNames.contains(PENDING_PROGRESS_STORE)) {
    db.deleteObjectStore(PENDING_PROGRESS_STORE);
  }
  if (!db.objectStoreNames.contains(PENDING_PROGRESS_STORE)) {
    db.createObjectStore(PENDING_PROGRESS_STORE, {
      keyPath: ["owner", "videoId"],
    });
  }
  if (!db.objectStoreNames.contains(RESUME_POSITIONS_STORE)) {
    db.createObjectStore(RESUME_POSITIONS_STORE, {
      keyPath: ["owner", "videoId"],
    });
  }
  if (!db.objectStoreNames.contains(DEVICE_ACCOUNTS_STORE)) {
    db.createObjectStore(DEVICE_ACCOUNTS_STORE, { keyPath: "userId" });
  }
  // Before version 3 each saved video carried one position for the whole
  // device: whoever played it last. Whose it was is unknown, so it is
  // dropped (as version 2 did with un-owned queued saves) rather than
  // handed to whichever account opens the video next.
  if (oldVersion >= 1 && oldVersion < 3 && transaction) {
    const items = transaction.objectStore(ITEMS_STORE).openCursor();
    items.onsuccess = () => {
      const cursor = items.result;
      if (!cursor) return;
      const item = cursor.value as OfflineItem;
      if (item.video) cursor.update(withoutWatchState(item));
      cursor.continue();
    };
  }
}

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) =>
      upgradeDb(req.result, event.oldVersion, req.transaction);
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

export async function deletePendingProgress(
  owner: number,
  videoId: number
): Promise<void> {
  await wrap(
    (await store(PENDING_PROGRESS_STORE, "readwrite")).delete([owner, videoId])
  );
}

export async function getPendingProgress(
  owner: number,
  videoId: number
): Promise<PendingProgress | undefined> {
  return wrap(
    (await store(PENDING_PROGRESS_STORE, "readonly")).get([owner, videoId])
  );
}

export async function putResumePosition(p: ResumePosition): Promise<void> {
  await wrap((await store(RESUME_POSITIONS_STORE, "readwrite")).put(p));
}

export async function getResumePosition(
  owner: number,
  videoId: number
): Promise<ResumePosition | undefined> {
  return wrap(
    (await store(RESUME_POSITIONS_STORE, "readonly")).get([owner, videoId])
  );
}

/** Every saved position of one account. */
export async function getResumePositions(
  owner: number
): Promise<ResumePosition[]> {
  const range = IDBKeyRange.bound([owner, -Infinity], [owner, Infinity]);
  return wrap((await store(RESUME_POSITIONS_STORE, "readonly")).getAll(range));
}

/** Forget every account's position in a video (its offline copy is gone). */
export async function deleteResumePositions(videoId: number): Promise<void> {
  const positions = await store(RESUME_POSITIONS_STORE, "readwrite");
  await new Promise<void>((resolve, reject) => {
    const req = positions.openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return resolve();
      if ((cursor.value as ResumePosition).videoId === videoId) cursor.delete();
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

export async function getAllDeviceAccounts(): Promise<DeviceAccount[]> {
  return wrap((await store(DEVICE_ACCOUNTS_STORE, "readonly")).getAll());
}

export async function putDeviceAccount(account: DeviceAccount): Promise<void> {
  await wrap((await store(DEVICE_ACCOUNTS_STORE, "readwrite")).put(account));
}

/** `/api/videos/12/stream` → 12, `/api/videos/-3/stream` → -3. */
export function streamVideoId(pathname: string): number | null {
  const m = /^\/api\/videos\/(-?\d+)\/stream$/.exec(pathname);
  return m ? Number(m[1]) : null;
}
