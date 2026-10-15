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

class ServiceWorkerUpdates {
  private waiting: ServiceWorker | null = null;
  private listeners = new Set<Listener>();
  private reloading = false;

  get ready(): boolean {
    return this.waiting !== null;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.ready);
    return () => this.listeners.delete(listener);
  }

  private setWaiting(worker: ServiceWorker | null) {
    this.waiting = worker;
    this.listeners.forEach((l) => l(this.ready));
  }

  /** Track `registration` and surface any worker that is waiting to activate. */
  watch(registration: ServiceWorkerRegistration): void {
    // A waiting worker only counts as an update when a page is already
    // controlled; on the very first install there is nothing to replace.
    const check = () => {
      if (registration.waiting && navigator.serviceWorker.controller) {
        this.setWaiting(registration.waiting);
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
      // Only reload for an update the user asked for, never on first install.
      if (this.reloading) window.location.reload();
    });
  }

  /** Activate the waiting worker; the page reloads on `controllerchange`. */
  applyUpdate(): void {
    const worker = this.waiting;
    if (!worker) return;
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
