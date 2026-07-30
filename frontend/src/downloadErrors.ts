/** Shared copy for classified download / yt-dlp failures. */

export type DownloadErrorKind =
  | "members"
  | "bot"
  | "pot"
  | "cookies"
  | "rate_limit"
  | "unavailable"
  | "postprocess"
  | "cancelled"
  | "unknown";

const LABELS: Record<string, string> = {
  members: "Members-only",
  bot: "Bot check",
  pot: "PO token",
  cookies: "Cookies / login",
  rate_limit: "Rate limited",
  unavailable: "Unavailable",
  postprocess: "Post-process failed",
  cancelled: "Cancelled",
  unknown: "Failed",
};

const HINTS: Record<string, string> = {
  members: "This video requires channel membership.",
  bot: "Check PO token health and cookies (Settings → System / YouTube access docs).",
  pot: "Ensure bgutil-pot is running and YTDLP_POT_BASE_URL is reachable.",
  cookies: "Refresh YTDLP_COOKIE_FILE or YTDLP_COOKIES_FROM_BROWSER.",
  rate_limit: "Wait and retry; avoid bursty browsing while downloads run.",
  unavailable: "The source may have removed or geo-blocked this video.",
  postprocess: "The file may still be salvageable — retry or check disk permissions.",
};

export function downloadErrorLabel(kind: string | null | undefined): string {
  if (!kind) return LABELS.unknown;
  return LABELS[kind] ?? LABELS.unknown;
}

export function downloadErrorHint(kind: string | null | undefined): string | null {
  if (!kind) return null;
  return HINTS[kind] ?? null;
}

export function downloadErrorToast(
  kind: string | null | undefined,
  message: string | null | undefined
): string {
  const label = downloadErrorLabel(kind);
  const msg = (message || "").trim();
  if (!msg) return label === "Failed" ? "Download failed" : `Download failed: ${label}`;
  if (kind && kind !== "unknown" && kind !== "cancelled") {
    return `${label}: ${msg}`;
  }
  return msg || "Download failed";
}
