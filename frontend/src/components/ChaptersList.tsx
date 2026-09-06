import { useRef } from "react";
import { useAnimatedClipHeight } from "../hooks/useAnimatedClipHeight";
import OverlayScrollThumb from "./OverlayScrollThumb";
import { formatTimestamp, type Chapter } from "../utils";

interface Props {
  chapters: Chapter[];
  /** Follows the description box; no independent toggle. */
  expanded?: boolean;
  /** Collapsed max height in rem. Matches the description clip when side-by-side. */
  collapsedRem?: number;
  className?: string;
}

/** Chapter list panel only (no independent title/toggle — parent owns expand). */
export default function ChaptersList({
  chapters,
  expanded = false,
  collapsedRem = 12,
  className = "",
}: Props) {
  const scrollRef = useRef<HTMLUListElement>(null);
  const chaptersKey = chapters
    .map((ch) => `${ch.startSec}:${ch.title}`)
    .join("|");
  useAnimatedClipHeight(scrollRef, expanded, collapsedRem, chaptersKey);
  if (chapters.length === 0) return null;
  const hourLong = chapters.some((ch) => ch.startSec >= 3600);

  return (
    <div
      className={`ui-panel group isolate relative flex h-fit w-full min-w-0 flex-col self-start overflow-hidden rounded-xl border border-ink-700 bg-ink-900 ring-1 ring-ink-700 ${className}`}
    >
      <ul
        ref={scrollRef}
        className="horde-meta-scrollbar min-h-0 space-y-0.5 overflow-y-auto py-2"
      >
        {chapters.map((ch) => (
          <li key={`${ch.startSec}-${ch.title}`}>
            <button
              type="button"
              onClick={() =>
                window.dispatchEvent(
                  new CustomEvent("horde:seek", {
                    detail: { sec: ch.startSec },
                  })
                )
              }
              className="ui-interactive flex w-full min-w-0 items-baseline gap-1.5 rounded-lg px-3 py-1 text-left text-sm text-gray-300 hover:bg-ink-800 hover:text-accent"
            >
              <span
                className={`shrink-0 font-mono text-[11px] tabular-nums leading-none text-gray-500 ${
                  hourLong ? "w-[7ch]" : "w-[5ch]"
                }`}
              >
                {formatTimestamp(ch.startSec)}
              </span>
              <span className="min-w-0 flex-1 whitespace-normal break-words">
                {ch.title}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <OverlayScrollThumb
        scrollRef={scrollRef}
        revision={`${expanded}-${chaptersKey}`}
      />
    </div>
  );
}
