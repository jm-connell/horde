/**
 * Paths the server answers itself (API, docs, assets): a navigation to one
 * must reach the network, never the SPA shell. Kept out of sw.ts so it can be
 * tested without a service worker.
 */
const NON_SPA_PREFIXES = [
  "/api/",
  "/wiki",
  "/docs",
  "/redoc",
  "/openapi.json",
  "/assets/",
];

/**
 * Matched without case and with extra leading slashes collapsed, as the
 * server routes `/API/x` and `//api/x` (to a JSON 404) rather than to the app.
 */
export function isServerOnlyPath(path: string): boolean {
  const normal = path.replace(/^\/+/, "/").toLowerCase();
  return NON_SPA_PREFIXES.some((p) => normal.startsWith(p));
}
