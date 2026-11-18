import { SOURCE, type Source } from "./sources";

/**
 * What the Recommended card outlines mean: beside the home tabs from `md`,
 * at the top of the Algorithm panel on phones. Each key is a small card
 * drawn with the same outline as the cards it explains.
 */
export default function SourceLegend({
  className = "",
}: {
  className?: string;
}) {
  return (
    <ul
      aria-label="What the outlines mean"
      data-horde="source-legend"
      className={`flex shrink-0 flex-wrap gap-x-3 gap-y-1 text-xs text-muted ${className}`}
    >
      {(Object.keys(SOURCE) as Source[]).map((source) => (
        <li key={source} className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className={`inline-block h-2.5 w-3.5 shrink-0 rounded-sm bg-ink-900 ${SOURCE[source].swatch}`}
          />
          {SOURCE[source].label}
        </li>
      ))}
    </ul>
  );
}
