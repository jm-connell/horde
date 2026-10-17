/// <reference types="vite/client" />
/**
 * Register the service worker (production builds only; `vite dev` serves
 * modules that must not be cached).
 *
 * A new worker installs in the background but stays `waiting`: it never
 * replaces the running release by itself. When one is waiting, subscribers
 * (the "Update available" toast) are told, and `applyUpdate()` asks it to
 * activate (SKIP_WAITING) and reloads once it has taken control.
 */

const UPDATE_CHECK_MS = 60 * 60 * 1000;

type Listener = (ready: boolean) => void;

/** The part of a ServiceWorker this class uses (lets tests pass fakes). */
export interface WaitingWorker extends EventTarget {
  state: string;
  postMessage(message: unknown): void;
}

export class ServiceWorkerUpdates {
  private waiting: WaitingWorker | null = null;
  private listeners = new Set<Listener>();
  private reloading = false;
  private watched = new WeakSet<object>();
  private registration: Pick<ServiceWorkerRegistration, "update"> | null = null;

  constructor(private readonly reload: () => void = () => location.reload()) {}

  get ready(): boolean {
    return this.waiting !== null;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.ready);
    return () => this.listeners.delete(listener);
  }

  private setWaiting(worker: WaitingWorker | null) {
    this.waiting = worker;
    this.listeners.forEach((l) => l(this.ready));
  }

  /**
   * Track a worker that is waiting to activate. It stops being an update as
   * soon as it activates (another tab accepted it) or becomes redundant
   * (superseded by a newer release).
   */
  adopt(worker: WaitingWorker): void {
    if (worker.state === "activated" || worker.state === "redundant") return;
    this.setWaiting(worker);
    if (this.watched.has(worker)) return;
    this.watched.add(worker);
    worker.addEventListener("statechange", () => {
      if (
        (worker.state === "activated" || worker.state === "redundant") &&
        this.waiting === worker
      ) {
        this.setWaiting(null);
      }
    });
  }

  /** Track `registration` and surface any worker that is waiting to activate. */
  /** The registration `reloadToLatest` asks for a new worker (set by `watch`). */
  trackRegistration(
    registration: Pick<ServiceWorkerRegistration, "update">
  ): void {
    this.registration = registration;
  }

  watch(registration: ServiceWorkerRegistration): void {
    this.trackRegistration(registration);
    // A waiting worker only counts as an update when a page is already
    // controlled; on the very first install there is nothing to replace.
    const check = () => {
      if (registration.waiting && navigator.serviceWorker.controller) {
        this.adopt(registration.waiting);
      }
    };
    check();
    registration.addEventListener("updatefound", () => {
      const installing = registration.installing;
      installing?.addEventListener("statechange", () => {
        if (installing.state === "installed") check();
      });
    });
    // Long-lived tabs (installed PWA) would otherwise never look for a release.
    const poll = () => void registration.update().catch(() => undefined);
    window.setInterval(poll, UPDATE_CHECK_MS);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") poll();
    });
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      // Only reload for an update this tab asked for, never on first install
      // and never because another tab accepted the update.
      if (this.reloading) this.reload();
    });
  }

  /**
   * Reload into the release the server serves now (after an in-app update).
   * A plain reload would be answered from the current worker's cached shell,
   * i.e. the old release, so first fetch the new worker and activate it. Falls
   * back to a plain reload without a worker, or when none arrives in time.
   */
  reloadToLatest(timeoutMs = 10_000): void {
    if (this.ready) {
      this.applyUpdate();
      return;
    }
    const registration = this.registration;
    if (!registration) {
      this.reload();
      return;
    }
    let done = false;
    let unsubscribe = () => {};
    const finish = (apply: boolean) => {
      if (done) return;
      done = true;
      globalThis.clearTimeout(timer);
      unsubscribe();
      if (apply) this.applyUpdate();
      else this.reload();
    };
    const timer = globalThis.setTimeout(() => finish(false), timeoutMs);
    unsubscribe = this.subscribe((ready) => {
      if (ready) finish(true);
    });
    registration.update().catch(() => finish(false));
  }

  /** Activate the waiting worker; the page reloads on `controllerchange`. */
  applyUpdate(): void {
    const worker = this.waiting;
    if (!worker) return;
    if (worker.state === "activated") {
      // Already active (accepted elsewhere): no controllerchange will follow.
      this.reload();
      return;
    }
    this.reloading = true;
    worker.postMessage({ type: "SKIP_WAITING" });
  }
}

export const swUpdates = new ServiceWorkerUpdates();

export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
  const register = () => {
    navigator.serviceWorker
      // Always revalidate sw.js itself so app updates are noticed promptly.
      .register("/sw.js", { scope: "/", updateViaCache: "none" })
      .then((registration) => swUpdates.watch(registration))
      .catch((err) => console.warn("Service worker registration failed", err));
  };
  if (document.readyState === "complete") register();
  else window.addEventListener("load", register, { once: true });
}
