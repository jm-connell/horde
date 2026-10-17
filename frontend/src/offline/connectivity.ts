import { safeStorage } from "../storage";

/**
 * Connection state for the nav status tag and offline mode.
 *
 * - `checking`: first probe (boot) or reconnect attempt in flight.
 * - `online`: server reachable with acceptable latency (tag hidden).
 * - `slow`: reachable but pings are slow; the tag offers going offline.
 * - `offline`: offline mode — only downloaded videos are shown.
 *
 * Offline mode is either automatic (server unreachable; cheap background
 * probes with backoff switch back automatically) or manual (user chose it,
 * e.g. on a slow connection; stays until they tap the tag to reconnect).
 */

export type NetStatus = "checking" | "online" | "slow" | "offline";

export interface ConnectivityState {
  status: NetStatus;
  /** True when offline mode was chosen by the user rather than detected. */
  manual: boolean;
  /** Show the "Go offline" offer (checking took long, or slow pings). */
  offerOffline: boolean;
  /** A user-triggered reconnect attempt is running. */
  reconnecting: boolean;
  /** Last round-trip time of /api/ping in ms. */
  latencyMs: number | null;
}

export const PING_URL = "/api/ping";
/** Offer the offline switch after this long without a first response. */
export const OFFER_AFTER_MS = 5_000;
/** Give up waiting and switch to offline mode automatically. */
export const AUTO_OFFLINE_AFTER_MS = 15_000;
/** Ping round trips above this count as a slow connection. */
export const SLOW_PING_MS = 2_500;
/** App requests slower than this trigger an immediate latency probe. */
export const SLOW_REQUEST_MS = 4_000;
const PING_TIMEOUT_MS = 10_000;
const ONLINE_INTERVAL_MS = 30_000;
const SLOW_INTERVAL_MS = 15_000;
const RETRY_MIN_MS = 3_000;
const RETRY_MAX_MS = 60_000;
const MANUAL_OFFLINE_KEY = "horde:offlineMode";

type Listener = () => void;

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

export interface ConnectivityDeps {
  ping(signal: AbortSignal): Promise<boolean>;
  clock: Clock;
  isVisible(): boolean;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
}

export class Connectivity {
  private state: ConnectivityState;
  private listeners = new Set<Listener>();
  private probeTimer: unknown = null;
  private offerTimer: unknown = null;
  private giveUpTimer: unknown = null;
  private inflight: Promise<void> | null = null;
  private failures = 0;
  private retryDelay = RETRY_MIN_MS;
  private lastSlowProbeAt = 0;
  private started = false;

  constructor(private deps: ConnectivityDeps) {
    const manual = this.readManual();
    this.state = {
      status: manual ? "offline" : "checking",
      manual,
      offerOffline: false,
      reconnecting: false,
      latencyMs: null,
    };
  }

  getState = (): ConnectivityState => this.state;

  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  get offlineMode(): boolean {
    return this.state.status === "offline";
  }

  /** Boot: probe immediately, offer offline after 5s, give up after 15s. */
  start(): void {
    if (this.started) return;
    this.started = true;
    // Manual offline, or the browser already said there is no network.
    if (this.state.status === "offline") return;
    this.beginChecking();
  }

  /** Tag click while offline, or browser `online` event. */
  reconnect(userInitiated = true): Promise<void> {
    // Browser `online` event: a manual offline choice stands until the user
    // taps the tag.
    if (!userInitiated && this.state.manual) return Promise.resolve();
    if (userInitiated) {
      this.writeManual(false);
      this.set({ manual: false, reconnecting: true });
    }
    return this.probe();
  }

  /** User chose offline mode (slow connection / tired of waiting). */
  goOffline(): void {
    this.clearTimers();
    this.writeManual(true);
    this.set({
      status: "offline",
      manual: true,
      offerOffline: false,
      reconnecting: false,
    });
  }

  /** Browser reports no network at all: switch right away (automatic). */
  browserOffline(): void {
    if (this.state.status === "offline") return;
    this.enterAutoOffline();
  }

  visibilityChanged(): void {
    if (!this.deps.isVisible()) return;
    if (this.state.status === "offline" && this.state.manual) return;
    void this.probe();
  }

  /**
   * Called by api.ts for each app request. Network errors and slow requests
   * trigger a (rate-limited) ping so we notice degradation mid-session.
   */
  reportRequest(durationMs: number, networkError: boolean): void {
    if (this.state.status === "offline") return;
    if (networkError) {
      void this.probe();
      return;
    }
    if (durationMs < SLOW_REQUEST_MS) return;
    const now = this.deps.clock.now();
    if (now - this.lastSlowProbeAt < SLOW_INTERVAL_MS) return;
    this.lastSlowProbeAt = now;
    void this.probe();
  }

  private beginChecking(): void {
    this.clearTimers();
    this.set({ status: "checking", offerOffline: false });
    const { clock } = this.deps;
    this.offerTimer = clock.setTimeout(() => {
      if (this.state.status === "checking") this.set({ offerOffline: true });
    }, OFFER_AFTER_MS);
    this.giveUpTimer = clock.setTimeout(() => {
      if (this.state.status === "checking") this.enterAutoOffline();
    }, AUTO_OFFLINE_AFTER_MS);
    void this.probe();
  }

  private probe(): Promise<void> {
    if (this.inflight) return this.inflight;
    this.inflight = this.runProbe().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async runProbe(): Promise<void> {
    const { clock } = this.deps;
    const ctrl = new AbortController();
    const timeout = clock.setTimeout(() => ctrl.abort(), PING_TIMEOUT_MS);
    const t0 = clock.now();
    let ok = false;
    try {
      ok = await this.deps.ping(ctrl.signal);
    } catch {
      ok = false;
    } finally {
      clock.clearTimeout(timeout);
    }
    const latency = clock.now() - t0;
    // User went offline manually while the probe ran: respect that.
    if (this.state.manual && this.state.status === "offline") {
      this.set({ reconnecting: false });
      return;
    }
    if (ok) this.onProbeSuccess(latency);
    else this.onProbeFailure();
  }

  private onProbeSuccess(latency: number): void {
    this.failures = 0;
    this.retryDelay = RETRY_MIN_MS;
    this.clearTimers();
    const slow = latency > SLOW_PING_MS;
    this.set({
      status: slow ? "slow" : "online",
      offerOffline: slow,
      reconnecting: false,
      latencyMs: latency,
      manual: false,
    });
    this.schedule(slow ? SLOW_INTERVAL_MS : ONLINE_INTERVAL_MS);
  }

  private onProbeFailure(): void {
    this.failures += 1;
    const { status } = this.state;
    if (status === "offline") {
      this.set({ reconnecting: false });
      this.scheduleRetry();
      return;
    }
    if (status === "checking") {
      // Boot / reconnect: keep the "Connecting…" tag; the give-up timer or a
      // second failure moves us to offline.
      if (this.failures >= 2) this.enterAutoOffline();
      else this.scheduleRetry();
      return;
    }
    // Was online/slow: one blip shows "Reconnecting…"; a second failure
    // switches to offline mode.
    if (this.failures >= 2) {
      this.enterAutoOffline();
    } else {
      this.set({ status: "checking", offerOffline: true });
      this.schedule(RETRY_MIN_MS);
    }
  }

  private enterAutoOffline(): void {
    this.clearTimers();
    this.set({
      status: "offline",
      manual: false,
      offerOffline: false,
      reconnecting: false,
    });
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.state.manual) return;
    const delay = this.retryDelay;
    this.retryDelay = Math.min(RETRY_MAX_MS, this.retryDelay * 2);
    this.schedule(delay);
  }

  private schedule(ms: number): void {
    const { clock } = this.deps;
    if (this.probeTimer !== null) clock.clearTimeout(this.probeTimer);
    this.probeTimer = clock.setTimeout(() => {
      this.probeTimer = null;
      // Skip background work while hidden; visibilitychange re-probes.
      if (!this.deps.isVisible()) return;
      void this.probe();
    }, ms);
  }

  private clearTimers(): void {
    const { clock } = this.deps;
    for (const t of [this.probeTimer, this.offerTimer, this.giveUpTimer]) {
      if (t !== null) clock.clearTimeout(t);
    }
    this.probeTimer = this.offerTimer = this.giveUpTimer = null;
  }

  private set(patch: Partial<ConnectivityState>): void {
    const next = { ...this.state, ...patch };
    const changed = (Object.keys(patch) as (keyof ConnectivityState)[]).some(
      (k) => this.state[k] !== next[k]
    );
    if (!changed) return;
    this.state = next;
    for (const fn of this.listeners) fn();
  }

  private readManual(): boolean {
    try {
      return this.deps.storage?.getItem(MANUAL_OFFLINE_KEY) === "1";
    } catch {
      return false;
    }
  }

  private writeManual(on: boolean): void {
    try {
      if (on) this.deps.storage?.setItem(MANUAL_OFFLINE_KEY, "1");
      else this.deps.storage?.removeItem(MANUAL_OFFLINE_KEY);
    } catch {
      // Private mode / blocked storage: manual offline just won't persist.
    }
  }
}

export const connectivity = new Connectivity({
  ping: async (signal) => {
    const resp = await fetch(PING_URL, { cache: "no-store", signal });
    return resp.ok;
  },
  clock: {
    now: () => Date.now(),
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (id) => globalThis.clearTimeout(id as number),
  },
  isVisible: () =>
    typeof document === "undefined" || document.visibilityState !== "hidden",
  storage: safeStorage("local"),
});

/** Wire browser events; call once from main.tsx. */
export function startConnectivity(): void {
  window.addEventListener("online", () => void connectivity.reconnect(false));
  window.addEventListener("offline", () => connectivity.browserOffline());
  document.addEventListener("visibilitychange", () =>
    connectivity.visibilityChanged()
  );
  if (navigator.onLine === false && !connectivity.offlineMode) {
    connectivity.browserOffline();
  }
  connectivity.start();
}
