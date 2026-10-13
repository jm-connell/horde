import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearDowngrade,
  isDowngradeFresh,
  readDowngrade,
  trackQuality,
  writeDowngrade,
} from "./decodeCapability";

/** Vitest runs in the `node` environment here, so back localStorage by hand. */
function installLocalStorage(): void {
  const store = new Map<string, string>();
  const mock = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: mock,
    configurable: true,
    writable: true,
  });
}

describe("trackQuality", () => {
  it("keys quality off the long side for landscape, portrait, and ultrawide", () => {
    expect(trackQuality({ width: 1920, height: 1080 })).toBe(1080);
    expect(trackQuality({ width: 1080, height: 1920 })).toBe(1080);
    expect(trackQuality({ width: 1920, height: 960 })).toBe(1080);
    expect(trackQuality({ width: 1280, height: 720 })).toBe(720);
  });

  it("returns 0 when dimensions are unknown", () => {
    expect(trackQuality({ width: null, height: null })).toBe(0);
    expect(trackQuality({})).toBe(0);
  });
});

describe("auto-downgrade freshness", () => {
  beforeEach(() => {
    installLocalStorage();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("treats a missing record as not fresh", () => {
    expect(isDowngradeFresh(null)).toBe(false);
  });

  it("trusts a just-recorded downgrade", () => {
    writeDowngrade({ maxHeight: 480, blacklistAv1: false });
    const rec = readDowngrade();
    expect(rec?.maxHeight).toBe(480);
    expect(isDowngradeFresh(rec)).toBe(true);
  });

  it("stops trusting a stale downgrade so Auto can climb again", () => {
    // The reported bug: a 480p cap recorded long ago kept Auto pinned to 480p
    // until the user manually picked 1080p.
    writeDowngrade({ maxHeight: 480, blacklistAv1: false });
    const stale = { ...readDowngrade()!, at: Date.now() - 20 * 60 * 1000 };
    expect(isDowngradeFresh(stale)).toBe(false);
  });

  it("treats a record without a timestamp as not fresh", () => {
    expect(
      isDowngradeFresh({
        maxHeight: 720,
        blacklistAv1: false,
        at: undefined as unknown as number,
      })
    ).toBe(false);
  });

  it("expires records past the TTL entirely", () => {
    localStorage.setItem(
      "horde.decode-downgrade.v1",
      JSON.stringify({
        maxHeight: 480,
        blacklistAv1: true,
        at: Date.now() - 45 * 60 * 1000,
      })
    );
    expect(readDowngrade()).toBeNull();
  });

  it("clearDowngrade removes the record", () => {
    writeDowngrade({ maxHeight: 720, blacklistAv1: true });
    expect(readDowngrade()).not.toBeNull();
    clearDowngrade();
    expect(readDowngrade()).toBeNull();
  });
});
