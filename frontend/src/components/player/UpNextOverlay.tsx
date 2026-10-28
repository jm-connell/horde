import { useId } from "react";
import type { UpNext } from "../videoPlayerTypes";
import { button } from "../buttons";

interface Props {
  upNext: UpNext;
  /** Ultrawide video: shrink the card so it stays inside the picture. */
  compact: boolean;
  autoplayRelated: boolean;
  onAutoplayRelatedChange?: (enabled: boolean) => void;
  onPlayNow?: () => void;
  onCancel?: () => void;
}

/** Countdown card shown over the player when the next video is about to start. */
export default function UpNextOverlay({
  upNext,
  compact,
  autoplayRelated,
  onAutoplayRelatedChange,
  onPlayNow,
  onCancel,
}: Props) {
  const autoplayRelatedId = useId();
  return (
    <div className="ui-up-next-scrim absolute inset-0 z-30 flex items-center justify-center overflow-hidden bg-black/65 p-4">
      <div
        className={`ui-panel ui-panel-legible w-full max-w-sm overflow-hidden rounded-xl border border-ink-700 bg-ink-900 shadow-2xl ring-1 ring-ink-600 ${
          compact ? "flex max-h-full flex-col sm:max-h-[min(100%,16rem)]" : ""
        }`}
      >
        {upNext.poster && (
          <div
            className={
              compact
                ? "max-h-18 w-full shrink-0 overflow-hidden bg-ink-800 sm:max-h-22"
                : "aspect-video w-full overflow-hidden bg-ink-800"
            }
          >
            <img
              decoding="async"
              width={320}
              height={180}
              src={upNext.poster}
              alt=""
              className="h-full w-full object-cover opacity-90"
            />
          </div>
        )}
        <div className={compact ? "min-h-0 flex-1 overflow-y-auto p-3" : "p-4"}>
          <p className="text-xs font-semibold uppercase tracking-wide text-accent">
            Playing next
            {upNext.seconds > 0 ? ` in ${upNext.seconds}s` : ""}
          </p>
          <p className="mt-1 line-clamp-2 text-sm font-medium text-gray-100">
            {upNext.title}
          </p>
          {upNext.channel && (
            <p className="mt-0.5 truncate text-xs text-muted">
              {upNext.channel}
            </p>
          )}
          {upNext.note && (
            <p className="mt-0.5 truncate text-xs text-accent/80">
              {upNext.note}
            </p>
          )}
          <div
            className={`flex flex-wrap items-center gap-3 ${
              compact ? "mt-3" : "mt-4"
            }`}
          >
            <button
              type="button"
              onClick={onPlayNow}
              className={`${button("primary", "sm")} flex-1`}
            >
              Play now
            </button>
            <button
              type="button"
              onClick={onCancel}
              className={button("secondary", "sm")}
            >
              Cancel
            </button>
          </div>
          {onAutoplayRelatedChange && (
            <label
              htmlFor={autoplayRelatedId}
              className={`flex items-center justify-between gap-3 border-t border-ink-700 pt-3 ${
                compact ? "mt-3" : "mt-4"
              }`}
            >
              <span className="text-xs text-gray-400">Autoplay related</span>
              <button
                id={autoplayRelatedId}
                type="button"
                role="switch"
                aria-checked={autoplayRelated}
                onClick={() => onAutoplayRelatedChange(!autoplayRelated)}
                className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
                  autoplayRelated ? "bg-accent" : "bg-ink-700"
                }`}
              >
                <span
                  className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${
                    autoplayRelated ? "translate-x-4" : "translate-x-0"
                  }`}
                />
              </button>
            </label>
          )}
        </div>
      </div>
    </div>
  );
}
