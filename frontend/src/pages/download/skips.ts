import type { DownloadBulkSkip } from "../../types";

const SKIP_TOAST: Record<string, string> = {
  already_queued: "Already queued",
  already_downloading: "Already downloading",
  already_in_library: "Already in library",
  playlist: "Skipped playlist link — paste it alone to import.",
  shorts: "Don’t watch shorts",
  duplicate_in_paste: "Skipped duplicate links",
  invalid_url: "Skipped links that are not public http(s) URLs",
};

export function toastBulkSkips(
  skips: DownloadBulkSkip[],
  showToast: (message: string) => void
) {
  if (skips.length === 0) return;
  const counts = new Map<string, number>();
  for (const skip of skips) {
    counts.set(skip.reason, (counts.get(skip.reason) ?? 0) + 1);
  }
  const parts: string[] = [];
  for (const [reason, n] of counts) {
    const msg = SKIP_TOAST[reason] ?? reason;
    parts.push(n > 1 && reason !== "playlist" ? `${msg} (${n})` : msg);
  }
  showToast(parts.join(" · "));
}
