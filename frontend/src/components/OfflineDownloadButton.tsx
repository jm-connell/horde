import { downloadFileUrl, triggerBrowserDownload } from "../api";
import { useConfirm } from "../context/ConfirmContext";
import HttpsHelp from "./HttpsHelp";
import { useToast } from "../context/ToastContext";
import {
  useOfflineDownloads,
  useOfflineItem,
  useOfflineMode,
} from "../offline/hooks";
import { offlineManager } from "../offline/manager";
import type { Video } from "../types";

export function DownloadIcon({
  className = "h-4 w-4",
}: {
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 19h14" />
    </svg>
  );
}

export function DownloadedIcon({
  className = "h-4 w-4",
}: {
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="12" cy="12" r="9" />
      <path d="m8 12.5 2.8 2.8L16.5 9.5" />
    </svg>
  );
}

/** Small circular progress ring. */
export function ProgressRing({
  progress,
  className = "h-4 w-4",
}: {
  progress: number;
  className?: string;
}) {
  const r = 9;
  const c = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 24 24" className={`${className} -rotate-90`} aria-hidden>
      <circle
        cx="12"
        cy="12"
        r={r}
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.25"
        strokeWidth="3"
      />
      <circle
        cx="12"
        cy="12"
        r={r}
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - Math.max(0, Math.min(1, progress)))}
      />
    </svg>
  );
}

export function useOfflineDownloadAction(video: Video) {
  const { item, progress } = useOfflineItem(video.id);
  const offline = useOfflineMode();
  // No Cache Storage / service worker outside secure contexts (plain http).
  const supported = !useOfflineDownloads().unsupported;
  const { showToast, showError } = useToast();
  const confirm = useConfirm();

  const status = item?.status;
  const label = !item
    ? "Download"
    : status === "complete"
      ? "Downloaded"
      : status === "error"
        ? "Retry download"
        : status === "paused"
          ? `Paused ${Math.round(progress * 100)}%`
          : status === "queued"
            ? progress > 0
              ? `Waiting ${Math.round(progress * 100)}%`
              : "Waiting…"
            : `${Math.round(progress * 100)}%`;

  const onClick = async () => {
    if (!supported) {
      // Plain http: explain why, and offer the old file save instead.
      const save = await confirm({
        title: "Offline downloads need HTTPS",
        body: <HttpsHelp />,
        confirmLabel: "Save file instead",
        cancelLabel: "Close",
      });
      if (save && video.id > 0)
        triggerBrowserDownload(downloadFileUrl(video.id));
      return;
    }
    if (!item || status === "error") {
      if (offline) {
        showToast("Reconnect to download videos");
        return;
      }
      try {
        await offlineManager.download(video);
        showToast("Downloading for offline viewing");
      } catch (err) {
        showError(err instanceof Error ? err.message : "Download failed");
      }
      return;
    }
    if (status === "paused") {
      offlineManager.resume(video.id);
      return;
    }
    const removing = status === "complete";
    const ok = await confirm({
      title: removing ? "Remove download?" : "Cancel download?",
      body: removing
        ? "This video will no longer be available offline on this device."
        : "The partially downloaded data will be deleted.",
      confirmLabel: removing ? "Remove" : "Cancel download",
      cancelLabel: "Keep",
      danger: true,
    });
    if (ok) await offlineManager.remove(video.id);
  };

  return { item, status, progress, label, onClick, supported };
}

/**
 * Primary "Download" button for offline viewing (shown prominently on mobile
 * Watch pages). Cycles Download → progress → Downloaded (tap to remove).
 */
export default function OfflineDownloadButton({
  video,
  className = "",
}: {
  video: Video;
  className?: string;
}) {
  const { item, status, progress, label, onClick } =
    useOfflineDownloadAction(video);
  const done = status === "complete";
  const active = item && !done && status !== "error";
  return (
    <button
      type="button"
      onClick={() => void onClick()}
      data-horde="offline-download"
      data-status={status ?? "none"}
      aria-label={done ? "Downloaded — remove download" : label}
      className={`ui-panel ui-interactive flex items-center gap-2 rounded-lg border border-ink-700 px-4 py-2 text-sm ring-1 ring-ink-700 hover:bg-ink-700 ${
        done ? "bg-accent/15 text-accent" : "bg-ink-800 text-gray-200"
      } ${className}`}
    >
      {done ? (
        <DownloadedIcon />
      ) : active ? (
        <ProgressRing progress={progress} />
      ) : (
        <DownloadIcon />
      )}
      <span className="tabular-nums">{label}</span>
    </button>
  );
}
