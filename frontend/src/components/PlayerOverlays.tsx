import LoadingIndicator from "./LoadingIndicator";

/** Buffering, error, quality notice, and cast overlays for VideoPlayer. */
export default function PlayerOverlays({
  buffering,
  mediaError,
  casting,
  castDeviceName,
  qualityNotice,
  compatMode,
  isMini,
  isPreview = false,
  onRetry,
}: {
  buffering: boolean;
  mediaError: string | null;
  casting: boolean;
  castDeviceName: string | null;
  qualityNotice: string | null;
  compatMode: boolean;
  isMini: boolean;
  /** DASH/stream preview — YouTube ingest is slow; show an explanation. */
  isPreview?: boolean;
  onRetry: () => void;
}) {
  const bufferingLabel = isPreview
    ? "This takes a minute (YouTube’s fault)"
    : "Buffering";
  return (
    <>
      {buffering && !mediaError && !casting && (
        <div className="pointer-events-none absolute inset-0 z-[5] flex items-center justify-center bg-black/35">
          <LoadingIndicator
            label={bufferingLabel}
            labelVisible={isPreview}
            className="py-0"
          />
        </div>
      )}

      {mediaError && !isMini && (
        <div className="absolute inset-0 z-[6] flex flex-col items-center justify-center gap-3 bg-black/80 px-4">
          <p className="max-w-sm text-center text-sm text-red-300">{mediaError}</p>
          <button
            type="button"
            onClick={onRetry}
            className="rounded-md bg-white/10 px-3 py-1.5 text-sm text-white hover:bg-white/20"
          >
            Retry
          </button>
        </div>
      )}

      {(qualityNotice || compatMode) && !mediaError && !isMini && (
        <div className="pointer-events-none absolute left-1/2 top-4 z-[6] -translate-x-1/2 rounded-full bg-black/70 px-3 py-1 text-xs text-gray-100">
          {qualityNotice ??
            (compatMode ? "Reduced quality (compatibility mode)" : null)}
        </div>
      )}

      {casting && !isMini && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center bg-black/80">
          <p className="text-sm text-gray-200">
            Casting to {castDeviceName ?? "TV"}
          </p>
        </div>
      )}
    </>
  );
}
