import type { CompatState } from "../types";

/**
 * Covers the player while the server rewrites the stored file so Safari can
 * play it (AAC audio, faststart; the video itself is copied, not re-encoded).
 */
export default function SafariPrepGate({
  prep,
  isMini,
}: {
  prep: CompatState | null;
  isMini: boolean;
}) {
  const pct = Math.round(prep?.progress ?? 0);
  const running = prep?.status === "running";
  return (
    <div
      role="status"
      className="absolute inset-0 z-7 flex flex-col items-center justify-center gap-2 bg-black/85 px-4 text-center"
    >
      <p
        className={isMini ? "text-xs text-gray-200" : "text-base text-gray-100"}
      >
        Preparing this video for Safari…{running ? ` ${pct}%` : ""}
      </p>
      {!isMini && (
        <p className="max-w-sm text-sm text-gray-400">
          It starts automatically when it is ready and stays saved for next
          time.
        </p>
      )}
    </div>
  );
}
