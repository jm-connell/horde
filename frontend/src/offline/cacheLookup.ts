/** Minimal CacheStorage surface so the lookup can be unit-tested. */
export interface CacheStorageLike {
  open(name: string): Promise<{
    match(
      req: RequestInfo | URL,
      opts?: CacheQueryOptions
    ): Promise<Response | undefined>;
  }>;
  match(
    req: RequestInfo | URL,
    opts?: CacheQueryOptions
  ): Promise<Response | undefined>;
}

/**
 * Find a cached response, preferring the CURRENT release's cache.
 *
 * CacheStorage.match() searches caches in creation order, so with the previous
 * release's shell cache still around (see sw.ts, activation) it would return the
 * OLD index.html and every navigation after an update would boot the previous
 * release. Looking in the current cache first fixes that; the global fallback
 * only matters for tabs still running an older bundle that request hashed
 * chunks the current release no longer has.
 */
export async function matchPreferCurrent(
  storage: CacheStorageLike,
  currentCache: string,
  req: RequestInfo | URL,
  opts?: CacheQueryOptions
): Promise<Response | undefined> {
  const current = await storage.open(currentCache);
  const hit = await current.match(req, opts);
  if (hit) return hit;
  return storage.match(req, opts);
}
