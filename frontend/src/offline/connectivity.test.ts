import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUTO_OFFLINE_AFTER_MS,
  Connectivity,
  OFFER_AFTER_MS,
  SLOW_PING_MS,
  SLOW_REQUEST_MS,
  type Clock,
} from "./connectivity";

const KEY = "horde:offlineMode";
const SLOW_INTERVAL = 15_000;
const ONLINE_INTERVAL = 30_000;

interface PendingPing {
  signal: AbortSignal;
  resolve(v: boolean): void;
  reject(e?: unknown): void;
}

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k: string) => (data.has(k) ? data.get(k)! : null),
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

function setup(opts: { storage?: ReturnType<typeof memoryStorage> } = {}) {
  const storage = opts.storage ?? memoryStorage();
  const pending: PendingPing[] = [];
  let pingCalls = 0;
  const visible = { value: true };
  const clock: Clock = {
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
  };
  const ping = vi.fn(
    (signal: AbortSignal) =>
      new Promise<boolean>((resolve, reject) => {
        pingCalls++;
        const p: PendingPing = { signal, resolve, reject };
        pending.push(p);
      }),
  );
  const c = new Connectivity({
    ping,
    clock,
    isVisible: () => visible.value,
    storage,
  });
  /** Resolve the oldest outstanding ping after `latency` ms of fake time. */
  const answer = async (ok: boolean | "reject", latency = 0) => {
    await vi.advanceTimersByTimeAsync(latency);
    const p = pending.shift();
    if (!p) throw new Error("no pending ping");
    if (ok === "reject") p.reject(new Error("net"));
    else p.resolve(ok);
    await vi.advanceTimersByTimeAsync(0);
  };
  return {
    c,
    storage,
    ping,
    pending,
    visible,
    answer,
    get pingCalls() {
      return pingCalls;
    },
  };
}

const adv = (ms: number) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("boot", () => {
  it("starts in checking and goes online on a fast ping", async () => {
    const h = setup();
    expect(h.c.getState().status).toBe("checking");
    h.c.start();
    expect(h.c.getState().status).toBe("checking");
    expect(h.ping).toHaveBeenCalledTimes(1);
    await h.answer(true, 120);
    const s = h.c.getState();
    expect(s.status).toBe("online");
    expect(s.offerOffline).toBe(false);
    expect(s.latencyMs).toBe(120);
    expect(s.manual).toBe(false);
    expect(h.c.offlineMode).toBe(false);
  });

  it("start() is idempotent", async () => {
    const h = setup();
    h.c.start();
    h.c.start();
    expect(h.ping).toHaveBeenCalledTimes(1);
  });

  it("offers offline after OFFER_AFTER_MS while still checking", async () => {
    const h = setup();
    h.c.start();
    await adv(OFFER_AFTER_MS - 1);
    expect(h.c.getState().offerOffline).toBe(false);
    await adv(1);
    expect(h.c.getState().status).toBe("checking");
    expect(h.c.getState().offerOffline).toBe(true);
  });

  it("goes automatically offline after AUTO_OFFLINE_AFTER_MS", async () => {
    const h = setup();
    h.c.start();
    await adv(AUTO_OFFLINE_AFTER_MS - 1);
    expect(h.c.getState().status).toBe("checking");
    await adv(1);
    const s = h.c.getState();
    expect(s.status).toBe("offline");
    expect(s.manual).toBe(false);
    expect(s.offerOffline).toBe(false);
    expect(h.storage.data.has(KEY)).toBe(false);
  });

  it("a late successful ping after auto-offline recovers (as slow, given its latency)", async () => {
    const h = setup();
    h.c.start();
    await adv(AUTO_OFFLINE_AFTER_MS);
    expect(h.c.getState().status).toBe("offline");
    h.pending[0].resolve(true);
    await adv(0);
    expect(h.c.getState().status).toBe("slow");
  });

  it("aborts the ping signal after the 10s ping timeout", async () => {
    const h = setup();
    h.c.start();
    const sig = h.pending[0].signal;
    expect(sig.aborted).toBe(false);
    await adv(9_999);
    expect(sig.aborted).toBe(false);
    await adv(1);
    expect(sig.aborted).toBe(true);
  });

  it("slow ping (> SLOW_PING_MS) gives status slow with offer", async () => {
    const h = setup();
    h.c.start();
    await h.answer(true, SLOW_PING_MS + 1);
    const s = h.c.getState();
    expect(s.status).toBe("slow");
    expect(s.offerOffline).toBe(true);
    expect(s.latencyMs).toBe(SLOW_PING_MS + 1);
  });

  it("ping of exactly SLOW_PING_MS is still online", async () => {
    const h = setup();
    h.c.start();
    await h.answer(true, SLOW_PING_MS);
    expect(h.c.getState().status).toBe("online");
  });

  it("two boot failures -> auto offline, then backoff retry recovers", async () => {
    const h = setup();
    h.c.start();
    await h.answer(false);
    expect(h.c.getState().status).toBe("checking");
    // first retry at 3s
    await adv(2_999);
    expect(h.ping).toHaveBeenCalledTimes(1);
    await adv(1);
    expect(h.ping).toHaveBeenCalledTimes(2);
    await h.answer("reject");
    expect(h.c.getState().status).toBe("offline");
    expect(h.c.getState().manual).toBe(false);
    // next retry backs off to 6s
    await adv(5_999);
    expect(h.ping).toHaveBeenCalledTimes(2);
    await adv(1);
    expect(h.ping).toHaveBeenCalledTimes(3);
    await h.answer(true, 50);
    const s = h.c.getState();
    expect(s.status).toBe("online");
    expect(s.manual).toBe(false);
    expect(s.latencyMs).toBe(50);
  });

  it("retry backoff doubles up to 60s", async () => {
    const h = setup();
    h.c.start();
    await h.answer(false); // retry in 3s
    const times: number[] = [];
    let last = Date.now();
    for (let i = 0; i < 9; i++) {
      // wait until next ping is issued
      const before = h.ping.mock.calls.length;
      while (h.ping.mock.calls.length === before) await adv(1_000);
      times.push(Date.now() - last);
      last = Date.now();
      await h.answer(false);
    }
    // 3,6,12,24,48,60,60... (1s granularity)
    expect(times.slice(0, 5)).toEqual([3_000, 6_000, 12_000, 24_000, 48_000]);
    expect(times.slice(5)).toEqual([60_000, 60_000, 60_000, 60_000]);
  });

  it("success resets backoff", async () => {
    const h = setup();
    h.c.start();
    await h.answer(false);
    await adv(3_000);
    await h.answer(false); // offline, next 6s
    await adv(6_000);
    await h.answer(true);
    expect(h.c.getState().status).toBe("online");
    // fail, fail -> offline; first retry should be 3s again
    await adv(ONLINE_INTERVAL);
    await h.answer(false); // checking, retry 3s
    await adv(3_000);
    await h.answer(false); // offline now
    expect(h.c.getState().status).toBe("offline");
    const n = h.ping.mock.calls.length;
    await adv(2_999);
    expect(h.ping.mock.calls.length).toBe(n);
    await adv(1);
    expect(h.ping.mock.calls.length).toBe(n + 1);
  });
});

describe("goOffline / persistence", () => {
  it("goOffline persists, sets manual offline, and stops probing", async () => {
    const h = setup();
    h.c.start();
    await h.answer(true);
    h.c.goOffline();
    const s = h.c.getState();
    expect(s.status).toBe("offline");
    expect(s.manual).toBe(true);
    expect(s.offerOffline).toBe(false);
    expect(s.reconnecting).toBe(false);
    expect(h.storage.getItem(KEY)).toBe("1");
    const n = h.ping.mock.calls.length;
    await adv(10 * 60_000);
    expect(h.ping.mock.calls.length).toBe(n);
  });

  it("goOffline during boot cancels offer/give-up timers and respects in-flight probe", async () => {
    const h = setup();
    h.c.start();
    h.c.goOffline();
    await adv(AUTO_OFFLINE_AFTER_MS + 1);
    expect(h.c.getState()).toMatchObject({ status: "offline", manual: true });
    // in-flight probe resolves ok: must not override manual offline
    h.pending[0].resolve(true);
    await adv(0);
    expect(h.c.getState()).toMatchObject({
      status: "offline",
      manual: true,
      reconnecting: false,
    });
    // in-flight probe failing must not schedule retries
    const h2 = setup();
    h2.c.start();
    h2.c.goOffline();
    h2.pending[0].resolve(false);
    await adv(0);
    const n = h2.ping.mock.calls.length;
    await adv(5 * 60_000);
    expect(h2.ping.mock.calls.length).toBe(n);
  });

  it("new instance with persisted flag starts offline/manual and doesn't probe", async () => {
    const storage = memoryStorage({ [KEY]: "1" });
    const h = setup({ storage });
    expect(h.c.getState()).toMatchObject({ status: "offline", manual: true });
    expect(h.c.offlineMode).toBe(true);
    h.c.start();
    await adv(5 * 60_000);
    expect(h.ping).not.toHaveBeenCalled();
    expect(h.c.getState()).toMatchObject({ status: "offline", manual: true });
  });

  it("round-trips through storage between instances", async () => {
    const storage = memoryStorage();
    const a = setup({ storage });
    a.c.start();
    await a.answer(true);
    a.c.goOffline();
    const b = setup({ storage });
    expect(b.c.getState().manual).toBe(true);
  });

  it("survives throwing storage", () => {
    const bad = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    const c = new Connectivity({
      ping: async () => true,
      clock: {
        now: () => Date.now(),
        setTimeout: (f, m) => setTimeout(f, m),
        clearTimeout: (i) => clearTimeout(i as ReturnType<typeof setTimeout>),
      },
      isVisible: () => true,
      storage: bad,
    });
    expect(c.getState().status).toBe("checking");
    expect(() => c.goOffline()).not.toThrow();
    expect(c.getState().manual).toBe(true);
  });

  it("works with null / undefined storage", () => {
    const c = new Connectivity({
      ping: async () => true,
      clock: {
        now: () => Date.now(),
        setTimeout: (f, m) => setTimeout(f, m),
        clearTimeout: (i) => clearTimeout(i as ReturnType<typeof setTimeout>),
      },
      isVisible: () => true,
      storage: null,
    });
    expect(c.getState().manual).toBe(false);
    c.goOffline();
    expect(c.getState().manual).toBe(true);
  });

  it("only the exact value '1' counts as persisted", () => {
    const h = setup({ storage: memoryStorage({ [KEY]: "0" }) });
    expect(h.c.getState().manual).toBe(false);
  });
});

describe("reconnect()", () => {
  async function manualOffline() {
    const h = setup();
    h.c.start();
    await h.answer(true);
    h.c.goOffline();
    return h;
  }

  it("clears flag, sets reconnecting, and success -> online", async () => {
    const h = await manualOffline();
    const p = h.c.reconnect();
    expect(h.storage.data.has(KEY)).toBe(false);
    expect(h.c.getState()).toMatchObject({
      status: "offline",
      manual: false,
      reconnecting: true,
    });
    await h.answer(true, 80);
    await p;
    expect(h.c.getState()).toMatchObject({
      status: "online",
      manual: false,
      reconnecting: false,
      latencyMs: 80,
    });
  });

  it("failure -> stays offline, manual false, reconnecting false, retries start", async () => {
    const h = await manualOffline();
    const p = h.c.reconnect();
    await h.answer(false);
    await p;
    expect(h.c.getState()).toMatchObject({
      status: "offline",
      manual: false,
      reconnecting: false,
    });
    const n = h.ping.mock.calls.length;
    await adv(3_000);
    expect(h.ping.mock.calls.length).toBe(n + 1);
    await h.answer(true);
    expect(h.c.getState().status).toBe("online");
  });

  it("rejecting ping behaves like failure", async () => {
    const h = await manualOffline();
    const p = h.c.reconnect();
    await h.answer("reject");
    await p;
    expect(h.c.getState()).toMatchObject({ status: "offline", reconnecting: false });
  });

  it("reconnect(false) in manual offline does not change state or ping", async () => {
    const h = await manualOffline();
    const n = h.ping.mock.calls.length;
    await h.c.reconnect(false);
    expect(h.ping.mock.calls.length).toBe(n);
    expect(h.c.getState()).toMatchObject({ status: "offline", manual: true });
    expect(h.storage.getItem(KEY)).toBe("1");
  });

  it("reconnect(false) from auto offline joins the in-flight probe", async () => {
    const h = setup();
    h.c.start();
    await adv(AUTO_OFFLINE_AFTER_MS);
    h.pending.length = 0;
    const p = h.c.reconnect(false);
    // joins in-flight probe; resolve it
    await adv(0);
    expect(h.c.getState().status).toBe("offline");
    expect(p).toBeInstanceOf(Promise);
  });

  it("goOffline during a reconnect probe wins", async () => {
    const h = await manualOffline();
    h.c.reconnect();
    h.c.goOffline();
    await h.answer(true);
    expect(h.c.getState()).toMatchObject({
      status: "offline",
      manual: true,
      reconnecting: false,
    });
    expect(h.storage.getItem(KEY)).toBe("1");
  });
});

describe("failures while online", () => {
  it("one failure -> checking (Reconnecting), second -> offline", async () => {
    const h = setup();
    h.c.start();
    await h.answer(true);
    await adv(ONLINE_INTERVAL);
    expect(h.ping).toHaveBeenCalledTimes(2);
    await h.answer(false);
    expect(h.c.getState()).toMatchObject({
      status: "checking",
      offerOffline: true,
    });
    await adv(3_000);
    expect(h.ping).toHaveBeenCalledTimes(3);
    await h.answer(false);
    expect(h.c.getState()).toMatchObject({
      status: "offline",
      manual: false,
      offerOffline: false,
    });
  });

  it("one failure then success returns to online", async () => {
    const h = setup();
    h.c.start();
    await h.answer(true);
    await adv(ONLINE_INTERVAL);
    await h.answer(false);
    await adv(3_000);
    await h.answer(true, 10);
    expect(h.c.getState()).toMatchObject({
      status: "online",
      offerOffline: false,
    });
  });

  it("polls every 30s while online and every 15s while slow", async () => {
    const h = setup();
    h.c.start();
    await h.answer(true);
    await adv(ONLINE_INTERVAL - 1);
    expect(h.ping).toHaveBeenCalledTimes(1);
    await adv(1);
    expect(h.ping).toHaveBeenCalledTimes(2);
    await h.answer(true, SLOW_PING_MS + 10);
    expect(h.c.getState().status).toBe("slow");
    await adv(SLOW_INTERVAL - 1);
    expect(h.ping).toHaveBeenCalledTimes(2);
    await adv(1);
    expect(h.ping).toHaveBeenCalledTimes(3);
  });

  it("slow -> fast clears the offer", async () => {
    const h = setup();
    h.c.start();
    await h.answer(true, SLOW_PING_MS + 1);
    await adv(SLOW_INTERVAL);
    await h.answer(true, 5);
    expect(h.c.getState()).toMatchObject({
      status: "online",
      offerOffline: false,
    });
  });
});

describe("reportRequest", () => {
  async function online() {
    const h = setup();
    h.c.start();
    await h.answer(true);
    return h;
  }

  it("network error triggers a probe", async () => {
    const h = await online();
    h.c.reportRequest(10, true);
    expect(h.ping).toHaveBeenCalledTimes(2);
  });

  it("fast successful request does nothing", async () => {
    const h = await online();
    h.c.reportRequest(SLOW_REQUEST_MS - 1, false);
    expect(h.ping).toHaveBeenCalledTimes(1);
  });

  it("slow request probes at most once per 15s window", async () => {
    const h = await online();
    h.c.reportRequest(SLOW_REQUEST_MS, false);
    expect(h.ping).toHaveBeenCalledTimes(2);
    await h.answer(true);
    h.c.reportRequest(SLOW_REQUEST_MS + 100, false);
    expect(h.ping).toHaveBeenCalledTimes(2);
    await adv(SLOW_INTERVAL - 1);
    h.c.reportRequest(SLOW_REQUEST_MS + 100, false);
    expect(h.ping.mock.calls.length).toBeLessThanOrEqual(2);
    await adv(1);
    h.c.reportRequest(SLOW_REQUEST_MS + 100, false);
    expect(h.ping.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("network errors are not rate limited by the slow window", async () => {
    const h = await online();
    h.c.reportRequest(SLOW_REQUEST_MS, false);
    await h.answer(true);
    h.c.reportRequest(5, true);
    expect(h.ping).toHaveBeenCalledTimes(3);
  });

  it("is ignored while offline (auto and manual)", async () => {
    const h = await online();
    h.c.goOffline();
    h.c.reportRequest(10, true);
    h.c.reportRequest(10_000, false);
    expect(h.ping).toHaveBeenCalledTimes(1);

    const g = setup();
    g.c.start();
    await adv(AUTO_OFFLINE_AFTER_MS);
    g.pending.length = 0;
    const n = g.ping.mock.calls.length;
    g.c.reportRequest(10, true);
    g.c.reportRequest(10_000, false);
    expect(g.ping.mock.calls.length).toBe(n);
  });

  it("network error + failing probe twice takes us offline", async () => {
    const h = await online();
    h.c.reportRequest(10, true);
    await h.answer(false);
    expect(h.c.getState().status).toBe("checking");
    h.c.reportRequest(10, true);
    await h.answer(false);
    expect(h.c.getState().status).toBe("offline");
  });
});

describe("browserOffline", () => {
  it("before start(): start() does not override offline state", async () => {
    const h = setup();
    h.c.browserOffline();
    expect(h.c.getState()).toMatchObject({ status: "offline", manual: false });
    h.c.start();
    expect(h.ping).not.toHaveBeenCalled();
    expect(h.c.getState().status).toBe("offline");
    // auto-retry still recovers it
    await adv(3_000);
    expect(h.ping).toHaveBeenCalledTimes(1);
    await h.answer(true);
    expect(h.c.getState().status).toBe("online");
  });

  it("while online -> auto offline with retries", async () => {
    const h = setup();
    h.c.start();
    await h.answer(true);
    h.c.browserOffline();
    expect(h.c.getState()).toMatchObject({ status: "offline", manual: false });
    await adv(3_000);
    expect(h.ping).toHaveBeenCalledTimes(2);
  });

  it("is a no-op when already manually offline", async () => {
    const h = setup();
    h.c.goOffline();
    h.c.browserOffline();
    expect(h.c.getState()).toMatchObject({ status: "offline", manual: true });
    await adv(60_000);
    expect(h.ping).not.toHaveBeenCalled();
  });
});

describe("visibility", () => {
  it("scheduled probes are skipped while hidden", async () => {
    const h = setup();
    h.c.start();
    await h.answer(true);
    h.visible.value = false;
    await adv(ONLINE_INTERVAL * 3);
    expect(h.ping).toHaveBeenCalledTimes(1);
  });

  it("visibilityChanged() when visible probes", async () => {
    const h = setup();
    h.c.start();
    await h.answer(true);
    h.visible.value = false;
    await adv(ONLINE_INTERVAL);
    h.c.visibilityChanged(); // still hidden -> nothing
    expect(h.ping).toHaveBeenCalledTimes(1);
    h.visible.value = true;
    h.c.visibilityChanged();
    expect(h.ping).toHaveBeenCalledTimes(2);
    await h.answer(true);
    // polling resumes
    await adv(ONLINE_INTERVAL);
    expect(h.ping).toHaveBeenCalledTimes(3);
  });

  it("visibilityChanged() in manual offline does not probe", async () => {
    const h = setup();
    h.c.goOffline();
    h.c.visibilityChanged();
    expect(h.ping).not.toHaveBeenCalled();
  });

  it("visibilityChanged() in auto offline probes", async () => {
    const h = setup();
    h.c.browserOffline();
    h.c.visibilityChanged();
    expect(h.ping).toHaveBeenCalledTimes(1);
  });

  it("hidden auto-offline retry is skipped, visibility re-probes", async () => {
    const h = setup();
    h.visible.value = false;
    h.c.browserOffline();
    await adv(60_000);
    expect(h.ping).not.toHaveBeenCalled();
    h.visible.value = true;
    h.c.visibilityChanged();
    expect(h.ping).toHaveBeenCalledTimes(1);
    await h.answer(true);
    expect(h.c.getState().status).toBe("online");
  });
});

describe("subscribe", () => {
  it("notifies on change and unsubscribe stops it", async () => {
    const h = setup();
    const fn = vi.fn();
    const off = h.c.subscribe(fn);
    h.c.start(); // status checking already, offerOffline already false: no change
    expect(fn).not.toHaveBeenCalled();
    await h.answer(true, 10);
    expect(fn).toHaveBeenCalled();
    const calls = fn.mock.calls.length;
    off();
    h.c.goOffline();
    expect(fn.mock.calls.length).toBe(calls);
  });

  it("does not notify when nothing changed", async () => {
    const h = setup();
    h.c.start();
    await h.answer(true, 10);
    await adv(ONLINE_INTERVAL);
    const fn = vi.fn();
    h.c.subscribe(fn);
    const before = h.c.getState();
    await h.answer(true, 10); // identical state
    expect(fn).not.toHaveBeenCalled();
    expect(h.c.getState()).toBe(before);
  });

  it("changes state identity only when something changes", async () => {
    const h = setup();
    h.c.goOffline();
    const s = h.c.getState();
    h.c.goOffline();
    expect(h.c.getState()).toBe(s);
  });

  it("notifies once per transition and gives fresh snapshots", async () => {
    const h = setup();
    const snaps: string[] = [];
    h.c.subscribe(() => snaps.push(h.c.getState().status));
    h.c.start();
    await h.answer(true, 10);
    h.c.goOffline();
    expect(snaps).toEqual(["online", "offline"]);
  });

  it("emits offerOffline transition separately", async () => {
    const h = setup();
    const fn = vi.fn();
    h.c.subscribe(fn);
    h.c.start();
    await adv(OFFER_AFTER_MS);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("probe de-duplication", () => {
  it("concurrent probes share one ping", async () => {
    const h = setup();
    h.c.start();
    h.c.reportRequest(1, true);
    h.c.reportRequest(1, true);
    h.c.visibilityChanged();
    void h.c.reconnect(false);
    expect(h.ping).toHaveBeenCalledTimes(1);
    await h.answer(true);
    h.c.reportRequest(1, true);
    expect(h.ping).toHaveBeenCalledTimes(2);
  });

  it("reconnect() returns the same in-flight promise result", async () => {
    const h = setup();
    h.c.browserOffline();
    const a = h.c.reconnect();
    const b = h.c.reconnect();
    expect(h.ping).toHaveBeenCalledTimes(1);
    await h.answer(true);
    await Promise.all([a, b]);
    expect(h.c.getState().status).toBe("online");
  });

  it("a rejected ping clears the in-flight slot", async () => {
    const h = setup();
    h.c.start();
    await h.answer("reject");
    h.c.reportRequest(1, true);
    expect(h.ping).toHaveBeenCalledTimes(2);
  });
});
