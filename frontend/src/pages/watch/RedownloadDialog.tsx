import { useRef } from "react";
import ThemedSelect from "../../components/ThemedSelect";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import type { Video } from "../../types";
import { formatResolution } from "../../utils";
import type { WatchActionsState } from "./useWatchActions";

const PRESET_LABELS: Record<string, string> = {
  best: "Best available",
  "2160p": "4K",
  "1440p": "1440p",
  "1080p": "1080p",
  "720p": "720p",
  "480p": "480p",
  audio: "Audio only",
};

/** "Change resolution": replaces the video file with a new download at another quality. */
export default function RedownloadDialog({
  video,
  actions,
}: {
  video: Video;
  actions: WatchActionsState;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, {
    active: actions.redownloadOpen,
    onEscape: () => actions.setRedownloadOpen(false),
  });
  return (
    <>
      {actions.redownloadOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div
            ref={dialogRef}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-labelledby="redownload-title"
            className="w-full max-w-md rounded-xl bg-ink-900 p-6 outline-none ring-1 ring-ink-700"
          >
            <h2
              id="redownload-title"
              className="mb-1 text-lg font-semibold text-gray-100"
            >
              Change resolution
            </h2>
            <p className="mb-4 text-sm text-gray-400">
              This replaces the video file on disk with a newly downloaded copy
              at the selected resolution. Your title, notes, and other metadata
              are kept. Playback may be unavailable until the download finishes.
            </p>
            {video.height_px != null && (
              <p className="mb-3 text-xs text-muted">
                Current file:{" "}
                <span className="text-gray-300">
                  {formatResolution(video.height_px) || `${video.height_px}p`}
                </span>
                {video.width_px != null
                  ? ` (${video.width_px}×${video.height_px})`
                  : ""}
              </p>
            )}
            <span className="mb-1 block text-xs font-medium text-gray-400">
              Quality
            </span>
            <ThemedSelect
              aria-label="Quality"
              value={actions.redownloadPreset}
              options={actions.presets.map((p) => ({
                value: p,
                label: PRESET_LABELS[p] ?? p,
              }))}
              onChange={actions.setRedownloadPreset}
              className="mb-2 w-full"
              buttonClassName="w-full px-3 py-2.5"
            />
            <p className="mb-6 text-xs text-muted">
              YouTube (and other sites) may not offer the selected tier. If the
              downloaded file is lower, Horde shows a toast when the job
              finishes.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => actions.setRedownloadOpen(false)}
                className="rounded-lg bg-ink-800 px-4 py-2 text-sm text-gray-200 hover:bg-ink-700"
              >
                Cancel
              </button>
              <button
                onClick={actions.onRedownload}
                disabled={actions.redownloading}
                className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-ink-950 hover:bg-accent-soft disabled:opacity-50"
              >
                {actions.redownloading ? "Starting…" : "Replace file"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
