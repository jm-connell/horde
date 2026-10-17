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

/** The bare API root has no trailing slash but the server answers it too. */
const NON_SPA_EXACT = ["/api"];

/** Percent-escapes are decoded the way the server does; bad ones stay as is. */
function decodePath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/**
 * Matched without case, with percent-escapes decoded (`/%61pi/x`) and extra
 * leading slashes collapsed, as the server routes `/API/x`, `//api/x` and
 * `/api` (to a JSON 404) rather than to the app.
 */
export function isServerOnlyPath(path: string): boolean {
  const normal = decodePath(path).replace(/^\/+/, "/").toLowerCase();
  return (
    NON_SPA_EXACT.includes(normal) ||
    NON_SPA_PREFIXES.some((p) => normal.startsWith(p))
  );
}
