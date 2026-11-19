import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { skipNoticeText, type SkipNotice } from "./useSkipSegments";

/** Exit fade length; the entrance runs 300ms (DESIGN.md "Motion"). */
const EXIT_MS = 200;

interface Props {
  notice: SkipNotice | null;
  isMini: boolean;
  controlsVisible: boolean;
  onSkip: () => void;
  onUndo: () => void;
}

/**
 * SponsorBlock chip: names the segment and offers Skip or Go back. Slides in
 * when a notice appears and fades out after it goes (the last notice stays
 * on screen for the exit).
 */
export default function SkipNoticeChip({
  notice,
  isMini,
  controlsVisible,
  onSkip,
  onUndo,
}: Props) {
  const [shown, setShown] = useState<SkipNotice | null>(notice);
  const leaving = !notice && !!shown;
  if (notice && notice !== shown) setShown(notice);
  useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(() => setShown(null), EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [leaving]);
  if (!shown) return null;
  const position = isMini
    ? "bottom-2"
    : controlsVisible
      ? "bottom-3 -translate-y-15"
      : "bottom-3";
  return (
    <div
      className={`ui-panel ui-panel-legible absolute right-3 z-8 flex cursor-auto items-center gap-2 rounded-lg border border-ink-700 bg-ink-900 px-2.5 py-1.5 shadow-lg ring-1 ring-ink-600 transition-[translate,opacity] ease-fluid starting:translate-x-4 starting:opacity-0 motion-reduce:transition-none ${position} ${
        leaving
          ? "pointer-events-none translate-x-4 opacity-0 duration-200"
          : "pointer-events-auto duration-300"
      }`}
      role="status"
      aria-hidden={leaving || undefined}
    >
      <Link
        to="/settings?tab=playback"
        className="text-xs font-medium text-gray-200 hover:text-accent"
        title="Open SponsorBlock settings"
        tabIndex={leaving ? -1 : undefined}
      >
        {skipNoticeText(shown)}
      </Link>
      {shown.kind === "prompt" && (
        <button
          type="button"
          onClick={onSkip}
          disabled={leaving}
          className="rounded-md bg-accent px-2 py-0.5 text-[11px] font-semibold text-on-accent hover:bg-accent-soft"
        >
          Skip
        </button>
      )}
      {shown.kind === "skipped" && (
        <button
          type="button"
          onClick={onUndo}
          disabled={leaving}
          className="rounded-md border border-ink-600 bg-ink-800 px-2 py-0.5 text-[11px] font-medium text-gray-200 hover:border-accent hover:text-accent"
        >
          Go back
        </button>
      )}
    </div>
  );
}
