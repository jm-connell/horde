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
  addEventListener(type: "install" | "activate", fn: (e: ExtendableEvent) => void): void;
  addEventListener(type: "fetch", fn: (e: FetchEvent) => void): void;
  addEventListener(type: "message", fn: (e: MessageEvent) => void): void;
}
const sw = self as unknown as SwScope;

const SHELL_CACHE = `horde-shell-${__SW_VERSION__}`;
const RUNTIME_CACHE = "horde-runtime-v1";
const RUNTIME_MAX_ENTRIES = 60;
const INDEX_URL = "/index.html";

/** Server-only paths that must never get the SPA shell. */
const NON_SPA_PREFIXES = ["/api/", "/wiki", "/docs", "/redoc", "/openapi.json", "/assets/"];

sw.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // `reload` bypasses the HTTP cache so a new version never precaches
      // stale files.
      await cache.addAll(__PRECACHE__.map((u) => new Request(u, { cache: "reload" })));
      await sw.skipWaiting();
    })(),
  );
});

sw.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k.startsWith("horde-shell-") && k !== SHELL_CACHE)
          .map((k) => caches.delete(k)),
      );
      await sw.clients.claim();
    })(),
  );
});

sw.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") void sw.skipWaiting();
});

sw.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== sw.location.origin) return;
  const path = url.pathname;

  if (req.mode === "navigate" && !NON_SPA_PREFIXES.some((p) => path.startsWith(p))) {
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

  if (/^\/api\/fonts\/[^/]+$/.test(path) || /^\/api\/backgrounds\/[^/]+$/.test(path)) {
    event.respondWith(staleWhileRevalidate(req, event));
  }
});

async function shellNavigation(req: Request): Promise<Response> {
  const cached = await caches.match(INDEX_URL);
  if (cached) return cached;
  return fetch(req);
}

async function cacheFirst(req: Request, cacheName: string): Promise<Response> {
  const hit = await caches.match(req, { ignoreSearch: true });
  if (hit) return hit;
  const resp = await fetch(req);
  if (resp.ok && resp.type === "basic") {
    const cache = await caches.open(cacheName);
    void cache.put(req, resp.clone());
  }
  return resp;
}

async function extrasFirst(req: Request): Promise<Response> {
  const cache = await caches.open(EXTRAS_CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  return fetch(req);
}

async function staleWhileRevalidate(req: Request, event: FetchEvent): Promise<Response> {
  const cache = await caches.open(RUNTIME_CACHE);
  const hit = await cache.match(req);
  const update = fetch(req).then(async (resp) => {
    if (resp.ok) {
      await cache.put(req, resp.clone());
      await trimCache(cache, RUNTIME_MAX_ENTRIES);
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
  rangeHeader: string | null,
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
    parts.push(s.from === 0 && s.to === blob.size ? blob : blob.slice(s.from, s.to));
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
