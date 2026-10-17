import { describe, expect, it } from "vitest";
import { matchPreferCurrent, type CacheStorageLike } from "./cacheLookup";

/** Fake CacheStorage that, like the real one, searches in creation order. */
function fakeStorage(
  caches: Record<string, Record<string, string>>
): CacheStorageLike {
  const names = Object.keys(caches);
  const find = (cache: Record<string, string>, req: RequestInfo | URL) => {
    const url = typeof req === "string" ? req : String(req);
    const key = url.split("?")[0];
    return key in cache ? new Response(cache[key]) : undefined;
  };
  return {
    open: async (name) => {
      caches[name] ??= {};
      if (!names.includes(name)) names.push(name);
      return { match: async (req) => find(caches[name], req) };
    },
    match: async (req) => {
      for (const name of names) {
        const hit = find(caches[name], req);
        if (hit) return hit;
      }
      return undefined;
    },
  };
}

describe("matchPreferCurrent", () => {
  const storage = () =>
    fakeStorage({
      "horde-shell-old": {
        "/index.html": "OLD index",
        "/assets/History-old.js": "old chunk",
      },
      "horde-shell-new": {
        "/index.html": "NEW index",
        "/assets/History-new.js": "new chunk",
      },
    });

  it("naive global match returns the older release (the bug)", async () => {
    const hit = await storage().match("/index.html");
    expect(await hit!.text()).toBe("OLD index");
  });

  it("navigations after an update get the NEW index.html", async () => {
    const hit = await matchPreferCurrent(
      storage(),
      "horde-shell-new",
      "/index.html"
    );
    expect(await hit!.text()).toBe("NEW index");
  });

  it("still serves an old release's hashed asset to a stale tab", async () => {
    const hit = await matchPreferCurrent(
      storage(),
      "horde-shell-new",
      "/assets/History-old.js"
    );
    expect(await hit!.text()).toBe("old chunk");
  });

  it("misses when no cache has the file", async () => {
    expect(
      await matchPreferCurrent(storage(), "horde-shell-new", "/nope")
    ).toBeUndefined();
  });
});
