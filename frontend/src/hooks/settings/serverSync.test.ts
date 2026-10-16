import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getAppSettings = vi.fn();
const updateAppSettings = vi.fn();

vi.mock("../../api", () => ({
  api: {
    getAppSettings: (...a: unknown[]) => getAppSettings(...a),
    updateAppSettings: (...a: unknown[]) => updateAppSettings(...a),
  },
  ApiError: class ApiError extends Error {
    status = 0;
  },
  withCsrf: (init: RequestInit) => init,
}));
vi.mock("../../offline/connectivity", () => ({
  connectivity: { offlineMode: false, subscribe: () => () => undefined },
}));

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

type Remote = {
  ui: Record<string, unknown>;
  setup_completed: boolean;
  progress_expiry_days: number;
};
const remote = (ui: Record<string, unknown>): Remote => ({
  ui,
  setup_completed: true,
  progress_expiry_days: 30,
});

/** Fresh module state (hydration flags, timers) for every test. */
async function load() {
  vi.resetModules();
  const [sync, pending, store, serverUi] = await Promise.all([
    import("./serverSync"),
    import("./pending"),
    import("./localStore"),
    import("./serverUi"),
  ]);
  return { sync, pending, store, serverUi };
}

beforeEach(() => {
  vi.useFakeTimers();
  getAppSettings.mockReset();
  updateAppSettings.mockReset().mockResolvedValue({});
  vi.stubGlobal("window", {
    localStorage: memoryStorage(),
    sessionStorage: memoryStorage(),
    dispatchEvent: () => true,
    addEventListener: () => undefined,
  });
  vi.stubGlobal("document", { addEventListener: () => undefined });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("hydration generation guard", () => {
  it("ignores a read that was in flight when the signed-in user changed", async () => {
    const { sync, store } = await load();
    sync.adoptSettingsOwner(1, false);
    const slow = deferred<Remote>();
    getAppSettings
      .mockReturnValueOnce(slow.promise)
      .mockResolvedValue(remote({ theme: "terminal" }));
    const first = sync.ensureServerHydration();
    sync.adoptSettingsOwner(2, false);
    // The old user's answer arrives after the switch.
    slow.resolve(remote({ theme: "nord" }));
    await first;
    await vi.runAllTimersAsync();
    expect(store.loadSettings().theme).toBe("terminal");
  });
});

describe("legacy preferences", () => {
  const legacy = async (isAdmin: boolean) => {
    const ctx = await load();
    ctx.store.persistLocal({ ...ctx.store.loadSettings(), theme: "nord" });
    ctx.sync.adoptSettingsOwner(5, isAdmin);
    getAppSettings.mockResolvedValue(remote({}));
    await ctx.sync.ensureServerHydration();
    await vi.runAllTimersAsync();
    return ctx;
  };

  it("are uploaded for the administrator who owns them", async () => {
    await legacy(true);
    expect(updateAppSettings).toHaveBeenCalledTimes(1);
    expect(updateAppSettings.mock.calls[0][0].ui.theme).toBe("nord");
  });

  it("are never uploaded for a member, and the cache is dropped", async () => {
    const { store } = await legacy(false);
    expect(updateAppSettings).not.toHaveBeenCalled();
    expect(store.loadSettings().theme).not.toBe("nord");
  });
});

describe("pending changes", () => {
  it("send nothing when no key changed", async () => {
    const { sync } = await load();
    sync.scheduleServerSync({});
    await vi.runAllTimersAsync();
    expect(updateAppSettings).not.toHaveBeenCalled();
  });

  it("are not cleared by an explicit save that a newer change overtook", async () => {
    const { sync, pending, store } = await load();
    sync.adoptSettingsOwner(1, true);
    store.persistLocal(store.loadSettings());
    sync.scheduleServerSync({ theme: "nord" });
    const inFlight = deferred<unknown>();
    updateAppSettings.mockReturnValueOnce(inFlight.promise);
    const flushing = sync.flushSettingsSync();
    // A change made while that request is on its way (same millisecond: time is frozen).
    sync.scheduleServerSync({ default_library_sort: "title" });
    inFlight.resolve({});
    await flushing;
    expect(pending.loadPending(true)?.ui).toMatchObject({
      default_library_sort: "title",
    });
  });

  it("are cleared by an acknowledgement of the explicit save", async () => {
    const { sync, pending } = await load();
    sync.adoptSettingsOwner(1, true);
    sync.scheduleServerSync({ theme: "nord" });
    await sync.flushSettingsSync();
    expect(pending.loadPending(true)).toBeNull();
  });

  it("are not pushed as the whole blob when hydration backfills a key", async () => {
    const { sync, serverUi } = await load();
    sync.adoptSettingsOwner(1, true);
    // The server has a blob without preview_muted.
    getAppSettings.mockResolvedValue(remote({ theme: "nord" }));
    await sync.ensureServerHydration();
    await vi.runAllTimersAsync();
    expect(updateAppSettings).toHaveBeenCalledTimes(1);
    const sent = updateAppSettings.mock.calls[0][0].ui as Record<
      string,
      unknown
    >;
    expect(Object.keys(sent)).toEqual(["preview_muted"]);
    expect(Object.keys(sent).length).toBeLessThan(
      Object.keys(
        serverUi.settingsToServerUi((await import("./defaults")).DEFAULTS)
      ).length
    );
  });
});
