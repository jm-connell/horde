/**
 * Horde service worker. Bundled by the `hordeServiceWorker` Vite plugin into
 * dist/sw.js with the build's precache list injected.
 *
 * - App shell (index.html + hashed assets + icons): cache-first, so launching
 *   the installed app never re-downloads the UI on a slow network.
 * - Offline videos: `/api/videos/{id}/stream` is answered from chunked Cache
 *   Storage (with HTTP Range support) when the video is fully downloaded.
 * - Offline extras (thumbnails, subtitles): cache-first from EXTRAS_CACHE.
 * - Everything else under /api goes straight to the network.
 */
import {
  EXTRAS_CACHE,
  MEDIA_CACHE,
  chunkUrl,
  getItem,
  streamVideoId,
  type OfflineItem,
} from "./db";
import { chunkSlices, parseRange, type ByteRange } from "./ranges";
import { matchPreferCurrent } from "./cacheLookup";
import { isServerOnlyPath } from "./serverPaths";

declare const __PRECACHE__: string[];
declare const __SW_VERSION__: string;

// Minimal SW typings (the app tsconfig uses the DOM lib, not "webworker").
interface ExtendableEvent extends Event {
  waitUntil(p: Promise<unknown>): void;
}
interface FetchEvent extends ExtendableEvent {
  request: Request;
  respondWith(r: Response | Promise<Response>): void;
}
interface SwScope {
  location: Location;
  skipWaiting(): Promise<void>;
  clients: { claim(): Promise<void> };
  addEventListener(
    type: "install" | "activate",
    fn: (e: ExtendableEvent) => void
  ): void;
  addEventListener(type: "fetch", fn: (e: FetchEvent) => void): void;
  addEventListener(type: "message", fn: (e: MessageEvent) => void): void;
}
const sw = self as unknown as SwScope;

// Bump when the shape of runtime-cached responses changes; activation deletes
// every other horde-runtime-* cache.
const RUNTIME_VERSION = 2;
const RUNTIME_PREFIX = "horde-runtime-";
const RUNTIME_CACHE = `${RUNTIME_PREFIX}v${RUNTIME_VERSION}`;
const SHELL_PREFIX = "horde-shell-";
const SHELL_CACHE = `${SHELL_PREFIX}${__SW_VERSION__}`;
/** Remembers which shell caches were activated, oldest first. */
const META_CACHE = "horde-sw-meta";
const VERSIONS_URL = "/__horde-shell-versions";
/** Shell generations kept after activation: this release plus the previous. */
const SHELL_GENERATIONS_KEPT = 2;
const RUNTIME_MAX_ENTRIES = 60;
const INDEX_URL = "/index.html";

/*
 * Update lifecycle
 *
 * A new worker installs (precaches its shell) but does NOT skipWaiting: it
 * waits until the page asks for it (SKIP_WAITING, sent when the user accepts
 * the "Update available" prompt) or until every old tab is closed. Taking over
 * mid-session would swap the cache under a page whose JS still references the
 * previous release's hashed chunks.
 *
 * Even after activation, tabs that were open before the update may still run
 * the previous bundle and lazy-load its chunks (React.lazy routes), which the
 * server no longer serves. So activation deletes only shell caches OLDER than
 * the previous release; the previous one stays until the next update. Lookups
 * use caches.match(), which searches every cache, so such a tab keeps working
 * until it reloads.
 */
sw.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // `reload` bypasses the HTTP cache so a new version never precaches
      // stale files.
      await cache.addAll(
        __PRECACHE__.map((u) => new Request(u, { cache: "reload" }))
      );
    })()
  );
});

sw.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Releases that were actually active before this one, oldest first.
      const activated = (await readShellVersions()).filter(
        (v) => v !== SHELL_CACHE
      );
      const keep = new Set([
        ...activated.slice(-(SHELL_GENERATIONS_KEPT - 1)),
        SHELL_CACHE,
      ]);
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter(
            (k) =>
              (k.startsWith(SHELL_PREFIX) && !keep.has(k)) ||
              (k.startsWith(RUNTIME_PREFIX) && k !== RUNTIME_CACHE)
          )
          .map((k) => caches.delete(k))
      );
      await writeShellVersions([...keep]);
      await sw.clients.claim();
    })()
  );
});

sw.addEventListener("message", (event) => {
  // Only a page (WindowClient) may activate a waiting worker.
  const source = event.source as { type?: string } | null;
  if (event.data?.type === "SKIP_WAITING" && source?.type === "window") {
    void sw.skipWaiting();
  }
});

async function readShellVersions(): Promise<string[]> {
  const cache = await caches.open(META_CACHE);
  const hit = await cache.match(VERSIONS_URL);
  if (!hit) return [];
  try {
    const parsed: unknown = await hit.json();
    return Array.isArray(parsed)
      ? parsed.filter((v): v is string => typeof v === "string")
      : [];
  } catch {
    return [];
  }
}

async function writeShellVersions(versions: string[]): Promise<void> {
  const cache = await caches.open(META_CACHE);
  await cache.put(
    VERSIONS_URL,
    new Response(JSON.stringify(versions), {
      headers: { "Content-Type": "application/json" },
    })
  );
}

sw.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== sw.location.origin) return;
  const path = url.pathname;

  if (req.mode === "navigate" && !isServerOnlyPath(path)) {
    event.respondWith(shellNavigation(req));
    return;
  }

  if (path.startsWith("/assets/") || __PRECACHE__.includes(path)) {
    event.respondWith(cacheFirst(req, SHELL_CACHE));
    return;
  }

  const streamId = streamVideoId(path);
  if (streamId !== null) {
    event.respondWith(offlineStream(streamId, req));
    return;
  }

  if (
    /^\/api\/thumbnails\/-?\d+$/.test(path) ||
    /^\/api\/videos\/-?\d+\/subtitles\/[^/]+$/.test(path)
  ) {
    event.respondWith(extrasFirst(req));
    return;
  }

  if (
    /^\/api\/fonts\/[^/]+$/.test(path) ||
    /^\/api\/backgrounds\/[^/]+$/.test(path)
  ) {
    event.respondWith(staleWhileRevalidate(req, event));
  }
});

async function shellNavigation(req: Request): Promise<Response> {
  const cached = await matchPreferCurrent(caches, SHELL_CACHE, INDEX_URL);
  if (cached) return cached;
  return fetch(req);
}

async function cacheFirst(req: Request, cacheName: string): Promise<Response> {
  const hit = await matchPreferCurrent(caches, cacheName, req, {
    ignoreSearch: true,
  });
  if (hit) return hit;
  const resp = await fetch(req);
  if (resp.ok && resp.type === "basic") {
    // A full disk must not fail a good network response.
    const copy = resp.clone();
    void caches
      .open(cacheName)
      .then((cache) => cache.put(req, copy))
      .catch((err) => console.warn("SW cache write failed", err));
  }
  return resp;
}

async function extrasFirst(req: Request): Promise<Response> {
  const cache = await caches.open(EXTRAS_CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  return fetch(req);
}

async function staleWhileRevalidate(
  req: Request,
  event: FetchEvent
): Promise<Response> {
  const cache = await caches.open(RUNTIME_CACHE);
  const hit = await cache.match(req);
  const update = fetch(req).then(async (resp) => {
    if (resp.ok) {
      try {
        await cache.put(req, resp.clone());
        await trimCache(cache, RUNTIME_MAX_ENTRIES);
      } catch (err) {
        // e.g. QuotaExceededError: still return the good network response.
        console.warn("SW runtime cache write failed", err);
      }
    }
    return resp;
  });
  if (hit) {
    event.waitUntil(update.catch(() => undefined));
    return hit;
  }
  return update;
}

async function trimCache(cache: Cache, max: number): Promise<void> {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}

async function offlineStream(videoId: number, req: Request): Promise<Response> {
  let item: OfflineItem | undefined;
  try {
    item = await getItem(videoId);
  } catch {
    item = undefined;
  }
  if (!item || item.status !== "complete" || !item.totalBytes) {
    return fetch(req);
  }
  const resp = await buildMediaResponse(item, req.headers.get("range"));
  return resp ?? fetch(req);
}

/** Returns null when a chunk is missing so the caller can fall back to network. */
async function buildMediaResponse(
  item: OfflineItem,
  rangeHeader: string | null
): Promise<Response | null> {
  const size = item.totalBytes;
  const parsed = parseRange(rangeHeader, size);
  if (parsed === "invalid") {
    return new Response(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${size}` },
    });
  }
  const full = parsed === null;
  // No Range header: answer with the whole file (blobs are disk-backed and
  // assembled lazily, so this does not read everything into memory).
  const range: ByteRange = parsed ?? { start: 0, end: size - 1 };
  const cache = await caches.open(MEDIA_CACHE);
  const parts: Blob[] = [];
  for (const s of chunkSlices(range, item.chunkSize)) {
    const hit = await cache.match(chunkUrl(item.videoId, s.index));
    if (!hit) return null;
    const blob = await hit.blob();
    parts.push(
      s.from === 0 && s.to === blob.size ? blob : blob.slice(s.from, s.to)
    );
  }
  const body = new Blob(parts, { type: item.contentType });
  const headers: Record<string, string> = {
    "Content-Type": item.contentType,
    "Content-Length": String(body.size),
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
  };
  if (full) return new Response(body, { status: 200, headers });
  headers["Content-Range"] = `bytes ${range.start}-${range.end}/${size}`;
  return new Response(body, { status: 206, headers });
}
