/**
 * Same-origin path from `?next=`; anything else falls back to the home page.
 *
 * Browsers strip tabs and newlines inside a URL and treat a backslash like a
 * slash, so `/\evil.example` and `/<TAB>/evil.example` both become
 * `//evil.example`. Reject control characters and backslashes outright, then
 * resolve against our own origin, require the result to stay on it, and
 * refuse a resolved path that starts with `//` (a protocol-relative URL).
 */
export function safeNextPath(raw: string | null): string {
  if (!raw || !raw.startsWith("/")) return "/";
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is being refused
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) return "/";
  // Tests run without a window; any fixed origin works for the comparison.
  const origin =
    typeof window === "undefined" ? "http://localhost" : window.location.origin;
  let url: URL;
  try {
    url = new URL(raw, origin);
  } catch {
    return "/";
  }
  if (url.origin !== origin) return "/";
  // Dot segments are resolved by the parser, so `/.//evil.example` becomes the
  // path `//evil.example`, which `location.assign` treats as another host.
  if (url.pathname.startsWith("//")) return "/";
  if (url.pathname === "/login" || url.pathname.startsWith("/login/"))
    return "/";
  return `${url.pathname}${url.search}${url.hash}`;
}
