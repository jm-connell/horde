const PAGES: [prefix: string, label: string][] = [
  ["/watch", "Watch page"],
  ["/history", "History"],
  ["/offline", "Offline downloads"],
  ["/download", "Download page"],
  ["/playlists", "Playlists"],
  ["/import", "Import page"],
  ["/settings", "Settings"],
  ["/account", "Account settings"],
];

/** Longest path (with query) sent; the label carries the meaning. */
const MAX_PATH = 100;

/**
 * One line telling Ask about Horde where the user is, e.g.
 * `Settings, AI tab (/settings)`. Sent with each question so "this
 * page" and vague questions have something to go on. At most 200
 * characters, well under the server's 300.
 */
export function describePage(
  pathname: string,
  search: string,
  extra: {
    /** What part of the page is showing, e.g. "AI tab". */
    detail?: string;
    /** A video is playing in the mini player. */
    miniPlayer?: boolean;
  } = {}
): string {
  let label =
    pathname === "/"
      ? "Library"
      : (PAGES.find(
          ([prefix]) => pathname === prefix || pathname.startsWith(`${prefix}/`)
        )?.[1] ?? "an unknown page");
  const detail = extra.detail?.trim();
  if (detail) label += `, ${detail.slice(0, 40)}`;
  if (extra.miniPlayer) label += ", with a video in the mini player";
  // Only Horde's own words and the URL: no video titles or search text,
  // which come from elsewhere and would steer the answer.
  return `${label} (${(pathname + search).slice(0, MAX_PATH)})`;
}
