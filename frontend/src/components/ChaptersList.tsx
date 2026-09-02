import { useRef } from "react";
import OverlayScrollThumb from "./OverlayScrollThumb";
import { formatTimestamp, type Chapter } from "../utils";

interface Props {
  chapters: Chapter[];
  /** When set, list scrolls inside this max height. */
  maxHeightClass?: string;
  className?: string;
}

/** Chapter list panel only (no independent title/toggle — parent owns expand). */
export default function ChaptersList({
  chapters,
  maxHeightClass = "max-h-64",
  className = "",
}: Props) {
  const scrollRef = useRef<HTMLUListElement>(null);
  if (chapters.length === 0) return null;
  const hourLong = chapters.some((ch) => ch.startSec >= 3600);

  return (
    <div
      className={`ui-panel group isolate relative flex flex-col overflow-hidden rounded-xl border border-ink-700 bg-ink-900 ring-1 ring-ink-700 ${className}`}
    >
      <ul
        ref={scrollRef}
        className={`horde-meta-scrollbar min-h-0 space-y-0.5 overflow-y-auto py-2 ${maxHeightClass}`}
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
        revision={chapters.length}
      />
    </div>
  );
}
