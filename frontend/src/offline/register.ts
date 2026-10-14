/// <reference types="vite/client" />
/**
 * Register the service worker (production builds only; `vite dev` serves
 * modules that must not be cached). The worker installs updates in the
 * background and takes over on the next launch / navigation.
 */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
  const register = () => {
    navigator.serviceWorker
      // Always revalidate sw.js itself so app updates are noticed promptly.
      .register("/sw.js", { scope: "/", updateViaCache: "none" })
      .catch(() => undefined);
  };
  if (document.readyState === "complete") register();
  else window.addEventListener("load", register, { once: true });
}
