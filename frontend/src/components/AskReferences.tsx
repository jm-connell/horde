import { Link } from "react-router-dom";
import { askWatchPath } from "../pages/ask/askLinks";
import { formatTimestamp } from "../utils";
import type { AskReference } from "./helpChat";

function where(ref: AskReference): string {
  return ref.is_description ? "description" : formatTimestamp(ref.start_sec);
}

/** A reference marker: a small superscript number that opens the moment. */
export function AskCite({
  reference,
  onNavigate,
}: {
  reference: AskReference;
  onNavigate?: () => void;
}) {
  return (
    <sup className="ml-0.5">
      <Link
        to={askWatchPath(reference)}
        onClick={onNavigate}
        title={`${reference.channel} · ${reference.title} · ${where(reference)}`}
        aria-label={`Reference ${reference.n}: ${reference.title} at ${where(reference)}`}
        className="rounded px-0.5 text-[0.7rem] font-semibold text-accent hover:underline"
      >
        {reference.n}
      </Link>
    </sup>
  );
}

/** The numbered list under an answer: channel, video, date and the moment, with the line said there. */
export function AskReferenceList({
  references,
  onNavigate,
}: {
  references: AskReference[];
  onNavigate?: () => void;
}) {
  if (!references.length) return null;
  return (
    <ol className="mt-3 space-y-1.5 border-t border-ink-700 pt-2 text-xs text-muted">
      {references.map((ref) => (
        <li key={ref.n} className="flex gap-1.5">
          <span className="w-4 shrink-0 text-right font-semibold text-gray-400">
            {ref.n}.
          </span>
          <span className="min-w-0">
            <Link
              to={askWatchPath(ref)}
              onClick={onNavigate}
              className="text-gray-300 hover:text-accent"
            >
              {ref.channel} · “{ref.title}”
              {ref.published_at ? ` (${ref.published_at.slice(0, 4)})` : ""}
            </Link>{" "}
            <span className="font-mono text-accent">{where(ref)}</span>
            {ref.line && (
              <span className="block truncate italic" title={ref.line}>
                “{ref.line}”
              </span>
            )}
          </span>
        </li>
      ))}
    </ol>
  );
}
