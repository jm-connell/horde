import { useId, useState } from "react";
import { Link } from "react-router-dom";
import { askWatchPath, seekIfOpen } from "../pages/ask/askLinks";
import { formatTimestamp } from "../utils";
import Collapse from "./Collapse";
import type { AskReference } from "./helpChat";
import { ChevronIcon } from "./icons";

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
        onClick={() => {
          seekIfOpen(askWatchPath(reference));
          onNavigate?.();
        }}
        title={`${reference.channel} · ${reference.title} · ${where(reference)}`}
        aria-label={`Reference ${reference.n}: ${reference.title} at ${where(reference)}`}
        className="rounded px-0.5 text-[0.7rem] font-semibold text-accent hover:underline"
      >
        {reference.n}
      </Link>
    </sup>
  );
}

/**
 * The references under an answer: folded to one "N references" line, since the
 * numbers in the text already open each moment. Unfolded, a numbered list of
 * channel, video, date and the moment, with what is said there.
 */
export function AskReferenceList({
  references,
  onNavigate,
}: {
  references: AskReference[];
  onNavigate?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  if (!references.length) return null;
  return (
    <div className="mt-3 border-t border-ink-700 pt-1.5 text-xs text-muted">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={listId}
        className="flex items-center gap-1.5 rounded-sm py-0.5 font-medium text-gray-400 hover:text-gray-200"
      >
        <ChevronIcon
          className={`transition-transform duration-200 ease-fluid motion-reduce:transition-none ${
            open ? "" : "-rotate-90"
          }`}
        />
        {references.length === 1
          ? "1 reference"
          : `${references.length} references`}
      </button>
      <Collapse open={open}>
        <ol id={listId} className="space-y-1.5 pt-1.5">
          {references.map((ref) => (
            <li key={ref.n} className="flex gap-1.5">
              <span className="w-4 shrink-0 text-right font-semibold text-gray-400">
                {ref.n}.
              </span>
              <span className="min-w-0">
                <Link
                  to={askWatchPath(ref)}
                  onClick={() => {
                    seekIfOpen(askWatchPath(ref));
                    onNavigate?.();
                  }}
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
      </Collapse>
    </div>
  );
}
