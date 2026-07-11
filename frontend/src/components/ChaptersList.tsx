import { formatTimestamp, type Chapter } from "../utils";

interface Props {
  chapters: Chapter[];
  /** When set, list scrolls inside a fixed max height matching the description panel. */
  maxHeightClass?: string;
  className?: string;
}

/** Chapter list panel only (no independent title/toggle — parent owns expand). */
export default function ChaptersList({
  chapters,
  maxHeightClass = "max-h-64",
  className = "",
}: Props) {
  if (chapters.length === 0) return null;

  return (
    <div
      className={`ui-panel isolate overflow-hidden rounded-xl border border-ink-700 bg-ink-900 ring-1 ring-ink-700 ${className}`}
    >
      <ul className={`horde-scrollbar space-y-1 overflow-y-auto px-4 py-3 ${maxHeightClass}`}>
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
              className="ui-interactive flex w-full min-w-0 items-center gap-3 rounded-lg px-2 py-1.5 text-left text-sm text-gray-300 hover:bg-ink-800 hover:text-accent"
            >
              <span className="w-12 shrink-0 font-mono text-xs text-gray-500">
                {formatTimestamp(ch.startSec)}
              </span>
              <span className="truncate">{ch.title}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
