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
    <div className="ui-panel overflow-hidden rounded-xl bg-ink-900 ring-1 ring-ink-700">
      <button
        type="button"
        onClick={() => updateSettings({ chaptersExpanded: !expanded })}
        className="ui-interactive flex w-full items-center justify-between px-4 py-3.5 text-xs font-semibold uppercase tracking-wide text-gray-400 hover:bg-ink-800/50 hover:text-accent"
      >
        <span>Chapters ({chapters.length})</span>
        <span>{expanded ? "▲" : "▼"}</span>
      </button>
      <Collapse open={expanded}>
        <ul className="space-y-1 px-4 pb-4">
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
      </Collapse>
    </div>
  );
}
