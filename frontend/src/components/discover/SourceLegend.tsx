import { SOURCE, type Source } from "./sources";

/** What the Recommended card outlines mean, beside the home tabs. */
export default function SourceLegend() {
  return (
    <ul
      aria-label="What the outlines mean"
      data-horde="source-legend"
      className="flex shrink-0 flex-wrap gap-x-3 gap-y-1 text-xs text-muted"
    >
      {(Object.keys(SOURCE) as Source[]).map((source) => (
        <li key={source} className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${SOURCE[source].dot}`}
          />
          {SOURCE[source].label}
        </li>
      ))}
    </ul>
  );
}
