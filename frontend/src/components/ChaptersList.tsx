import Collapse from "./Collapse";
import { useSettings } from "../hooks/useSettings";
import { formatTimestamp, type Chapter } from "../utils";

interface Props {
  chapters: Chapter[];
}

export default function ChaptersList({ chapters }: Props) {
  const [settings, updateSettings] = useSettings();
  const expanded = settings.chaptersExpanded;

  if (chapters.length === 0) return null;

  return (
    <div>
      <button
        type="button"
        onClick={() => updateSettings({ chaptersExpanded: !expanded })}
        className="ui-panel-toggle ui-interactive flex w-full items-center justify-between py-2 text-xs font-semibold uppercase tracking-wide text-gray-400 hover:text-accent"
      >
        <span className="ui-panel-toggle-press inline-flex items-center gap-2 transition-transform">
          <span>Chapters ({chapters.length})</span>
          <span>{expanded ? "▲" : "▼"}</span>
        </span>
      </button>
      <Collapse open={expanded}>
        <div className="ui-panel overflow-hidden rounded-xl bg-ink-900 ring-1 ring-ink-700">
          <ul className="space-y-1 px-4 py-3">
            {chapters.map((ch) => (
              <li key={`${ch.startSec}-${ch.title}`}>
                <button
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
      </Collapse>
    </div>
  );
}
