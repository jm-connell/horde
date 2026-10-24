import { firstHttpUrl } from "./clipboard";

/**
 * The link in a share-sheet or bookmarklet visit to `/download`. The Web Share
 * Target API sends `title`, `text` and `url`; Android's YouTube share puts the
 * link inside `text` ("Check this out https://youtu.be/xyz") and leaves `url`
 * empty. Only an http(s) link counts, so a stray `javascript:` value is
 * ignored. Returns null when nothing usable was sent.
 */
export function sharedUrlFromParams(params: URLSearchParams): string | null {
  for (const key of ["url", "text", "title"]) {
    const found = firstHttpUrl(params.get(key) ?? "");
    if (found) return found;
  }
  return null;
}

/** The `javascript:` link a browser bookmark runs on the page being viewed. */
export function bookmarkletHref(origin: string): string {
  const target = JSON.stringify(`${origin}/download?url=`);
  return `javascript:void(window.open(${target}+encodeURIComponent(location.href),"_blank"))`;
}
