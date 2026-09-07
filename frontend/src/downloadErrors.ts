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
  cookies: "Age-restricted / private",
  rate_limit: "Rate limited",
  unavailable: "Unavailable",
  postprocess: "Post-process failed",
  cancelled: "Cancelled",
  unknown: "Failed",
};

const HINTS: Record<string, string> = {
  members: "Member videos can't be downloaded without a signed-in account that has membership.",
  bot: "Check PO token health and cookies (Settings → System / YouTube access docs).",
  pot: "Ensure bgutil-pot is running and YTDLP_POT_BASE_URL is reachable.",
  cookies:
    "Public videos don't need cookies. Age-restricted, members-only, and private videos do — and that requires a signed-in account, which is not anonymous.",
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

export function extractFailureCopy(failure: {
  message: string;
  target?: string | null;
}): { target: string | null; message: string } {
  const target = (failure.target || "").trim() || null;
  let message = failure.message || "";
  if (target) {
    const suffix = ` On: ${target}`;
    if (message.endsWith(suffix)) {
      message = message.slice(0, -suffix.length).trimEnd();
    }
  }
  return { target, message };
}
