import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getItem,
  getJson,
  runStorageMigrations,
  setItem,
  setJson,
  STORAGE_VERSION_KEY,
  type StorageMigration,
} from "./storage";

function memoryStorage(opts: { failWrites?: boolean } = {}) {
  const map = new Map<string, string>();
  return {
    map,
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (opts.failWrites) throw new DOMException("full", "QuotaExceededError");
      map.set(k, v);
    },
    removeItem: (k: string) => void map.delete(k),
  };
}

let local: ReturnType<typeof memoryStorage>;

beforeEach(() => {
  local = memoryStorage();
  vi.stubGlobal("window", {
    localStorage: local,
    sessionStorage: memoryStorage(),
  });
});
afterEach(() => vi.unstubAllGlobals());

const isNumberArray = (v: unknown): v is number[] =>
  Array.isArray(v) && v.every((n) => typeof n === "number");

describe("safe access", () => {
  it("returns fallbacks for missing, corrupt and invalid JSON", () => {
    expect(getJson("k", isNumberArray, [])).toEqual([]);
    local.map.set("k", "{not json");
    expect(getJson("k", isNumberArray, [9])).toEqual([9]);
    local.map.set("k", JSON.stringify(["a"]));
    expect(getJson("k", isNumberArray, [9])).toEqual([9]);
    local.map.set("k", JSON.stringify([1, 2]));
    expect(getJson("k", isNumberArray, [9])).toEqual([1, 2]);
  });

  it("reports quota failures instead of throwing", () => {
    vi.stubGlobal("window", {
      localStorage: memoryStorage({ failWrites: true }),
    });
    expect(setItem("k", "v")).toBe(false);
    expect(setJson("k", { a: 1 })).toBe(false);
    expect(getItem("k")).toBeNull();
  });

  it("survives an accessor that throws (blocked site data)", () => {
    vi.stubGlobal("window", {
      get localStorage(): Storage {
        throw new DOMException("denied", "SecurityError");
      },
    });
    expect(getItem("k")).toBeNull();
    expect(setItem("k", "v")).toBe(false);
  });
});

describe("migrations", () => {
  it("runs pending steps in order, once, and records the version", () => {
    const order: number[] = [];
    const steps: StorageMigration[] = [1, 2, 3].map((version) => ({
      version,
      description: `step ${version}`,
      run: () => void order.push(version),
    }));
    local.map.set(STORAGE_VERSION_KEY, "1");
    runStorageMigrations(steps);
    runStorageMigrations(steps);
    expect(order).toEqual([2, 3]);
    expect(local.map.get(STORAGE_VERSION_KEY)).toBe("3");
  });

  it("stops at a failing step and retries it next boot", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let fail = true;
    const steps: StorageMigration[] = [
      { version: 1, description: "ok", run: () => undefined },
      {
        version: 2,
        description: "flaky",
        run: () => {
          if (fail) throw new Error("boom");
        },
      },
    ];
    runStorageMigrations(steps);
    expect(local.map.get(STORAGE_VERSION_KEY)).toBe("1");
    fail = false;
    runStorageMigrations(steps);
    expect(local.map.get(STORAGE_VERSION_KEY)).toBe("2");
  });

  it("folds the legacy preview-mute flag into settings without clobbering", () => {
    local.map.set("horde.previewMuted", "1");
    local.map.set("horde.settings", JSON.stringify({ theme: "dark" }));
    local.map.set("horde.mini-pos", "{}");
    local.map.set("horde.settings.tab", "downloads");
    runStorageMigrations();
    expect(JSON.parse(local.map.get("horde.settings")!)).toEqual({
      theme: "dark",
      previewMuted: true,
    });
    expect(local.map.has("horde.previewMuted")).toBe(false);
    expect(local.map.has("horde.mini-pos")).toBe(false);
    expect(local.map.get("horde.settings.tab")).toBe("library");
  });

  it("keeps an explicit previewMuted over the legacy flag", () => {
    local.map.set("horde.previewMuted", "0");
    local.map.set("horde.settings", JSON.stringify({ previewMuted: true }));
    runStorageMigrations();
    expect(JSON.parse(local.map.get("horde.settings")!).previewMuted).toBe(
      true
    );
  });
});
