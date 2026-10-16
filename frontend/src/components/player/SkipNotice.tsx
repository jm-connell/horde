import { Link } from "react-router-dom";
import { skipNoticeText, type SkipNotice } from "./useSkipSegments";

interface Props {
  notice: SkipNotice;
  isMini: boolean;
  controlsVisible: boolean;
  onSkip: () => void;
  onUndo: () => void;
}

/** SponsorBlock chip: names the segment and offers Skip or Go back. */
export default function SkipNoticeChip({
  notice,
  isMini,
  controlsVisible,
  onSkip,
  onUndo,
}: Props) {
  return (
    <div
      className={`ui-panel ui-panel-legible pointer-events-auto absolute right-3 z-[8] flex cursor-auto items-center gap-2 rounded-lg border border-ink-700 bg-ink-900 px-2.5 py-1.5 shadow-lg ring-1 ring-ink-600 transition-[bottom] duration-300 ease-out ${
        isMini ? "bottom-2" : controlsVisible ? "bottom-[4.5rem]" : "bottom-3"
      }`}
      role="status"
    >
      <Link
        to="/settings?tab=playback"
        className="text-xs font-medium text-gray-200 hover:text-accent"
        title="Open SponsorBlock settings"
      >
        {skipNoticeText(notice)}
      </Link>
      {notice.kind === "prompt" && (
        <button
          type="button"
          onClick={onSkip}
          className="rounded-md bg-accent px-2 py-0.5 text-[11px] font-semibold text-ink-950 hover:bg-accent-soft"
        >
          Skip
        </button>
      )}
      {notice.kind === "skipped" && (
        <button
          type="button"
          onClick={onUndo}
          className="rounded-md border border-ink-600 bg-ink-800 px-2 py-0.5 text-[11px] font-medium text-gray-200 hover:border-accent hover:text-accent"
        >
          Go back
        </button>
      )}
    </div>
  );
}
