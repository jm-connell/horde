import type { CompatState, Video } from "../types";
import { formatSize } from "../utils";
import { codecLabel, estimateCompatBytes } from "../utils/playbackRendition";

const STAGE_LABEL: Record<string, string> = {
  queued: "Waiting for a free slot on the server",
  downloading: "Downloading YouTube’s H.264 version",
  encoding: "Converting on the server",
  finishing: "Finishing up",
};

/**
 * Covers the player when this device cannot decode the stored original and
 * no H.264 copy exists yet. Shows sidecar progress or offers to create one.
 */
export default function CompatGate({
  video,
  compat,
  originalFailed,
  isMini,
  onRequest,
  onForceOriginal,
  copyCap = 1080,
}: {
  /** Short-side cap of copies (1080, or 2160 for "Full resolution"). */
  copyCap?: number;
  video: Video;
  compat: CompatState | null;
  originalFailed: boolean;
  isMini: boolean;
  onRequest: () => void;
  onForceOriginal: () => void;
}) {
  const label = codecLabel(video);
  const status = compat?.status ?? "none";
  const pending = status === "queued" || status === "running";
  const pct = Math.round(compat?.progress ?? 0);

  if (isMini) {
    return (
      <div className="absolute inset-0 z-7 flex items-center justify-center bg-black/85 px-3 text-center text-xs text-white">
        {pending
          ? `Preparing compatible copy… ${pct}%`
          : `Can’t play ${label} here`}
      </div>
    );
  }

  return (
    <div className="absolute inset-0 z-7 flex flex-col items-center justify-center gap-3 bg-black/85 px-6 text-center">
      <p className="text-base font-medium text-gray-100">
        {originalFailed
          ? `This device couldn’t play the ${label} video`
          : `This device can’t decode ${label} video`}
      </p>

      {pending ? (
        <>
          <p className="max-w-sm text-sm text-gray-300">
            Making an H.264 copy that plays everywhere. It starts automatically
            when it’s ready, and stays saved for next time.
          </p>
          <div className="w-64 max-w-full">
            <div className="h-1.5 overflow-hidden rounded-full bg-white/15">
              <div
                className="h-full w-full rounded-full bg-accent transition-transform duration-500 ease-linear"
                style={{ transform: `translateX(${Math.max(3, pct) - 100}%)` }}
              />
            </div>
            <p className="mt-1.5 text-xs text-gray-400">
              {STAGE_LABEL[compat?.stage ?? "queued"] ?? "Working"}
              {status === "running" ? ` · ${pct}%` : ""}
            </p>
          </div>
        </>
      ) : status === "error" ? (
        <>
          <p className="max-w-sm text-sm text-red-300">
            Creating the H.264 copy failed: {compat?.error ?? "unknown error"}
          </p>
          <button
            type="button"
            onClick={onRequest}
            className="rounded-md bg-white/10 px-3 py-1.5 text-sm text-white hover:bg-white/20"
          >
            Try again
          </button>
        </>
      ) : (
        <>
          <p className="max-w-sm text-sm text-gray-300">
            Horde can make an H.264 copy (up to{" "}
            {copyCap >= 2160 ? "4K" : "1080p"}) that plays on almost any device.
            It’s saved next to the original and uses about{" "}
            {formatSize(estimateCompatBytes(video, copyCap))} more storage.
          </p>
          <button
            type="button"
            onClick={onRequest}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-on-accent hover:bg-accent-soft"
          >
            Create compatible copy
          </button>
        </>
      )}

      {!originalFailed && (
        <button
          type="button"
          onClick={onForceOriginal}
          className="text-xs text-gray-400 underline-offset-2 hover:text-gray-200 hover:underline"
        >
          Try playing the original anyway
        </button>
      )}
    </div>
  );
}
