import { Link } from "react-router-dom";
import { button } from "../../components/buttons";
import type { useAskSearch } from "../../queries/ask";
import { formatTimestamp, youtubeListThumbnailUrl } from "../../utils";
import { askWatchPath, snippetParts, type VideoGroup } from "../ask/askLinks";

/** A caption passage with the matching words highlighted. */
export function Snippet({ text }: { text: string }) {
  return (
    <>
      {snippetParts(text).map((part, i) =>
        part.mark ? (
          <mark key={i} className="rounded bg-accent/20 px-0.5 text-gray-100">
            {part.text}
          </mark>
        ) : (
          <span key={i}>{part.text}</span>
        )
      )}
    </>
  );
}

/**
 * Search results from Ask channels' captions: passages grouped by video, each
 * timestamp a link to the moment it was said.
 */
export default function SaidInVideos({
  groups,
  search,
}: {
  groups: VideoGroup[];
  search: ReturnType<typeof useAskSearch>;
}) {
  return (
    <>
      <ul className="space-y-3">
        {groups.map((g) => (
          <li
            key={g.yt_id}
            className="ui-panel flex gap-3 rounded-xl bg-ink-900 p-3 ring-1 ring-ink-700"
          >
            <Link
              to={askWatchPath(g.hits[0])}
              className="shrink-0"
              aria-hidden
              tabIndex={-1}
            >
              <img
                src={youtubeListThumbnailUrl(g.yt_id) ?? undefined}
                alt=""
                loading="lazy"
                className="h-12 w-20 rounded-md object-cover sm:h-16 sm:w-28"
              />
            </Link>
            <div className="min-w-0 flex-1">
              <Link
                to={askWatchPath(g.hits[0])}
                className="font-medium text-gray-100 hover:text-accent"
              >
                {g.title || g.yt_id}
              </Link>
              <p className="text-xs text-muted">
                {[g.channel, g.published?.slice(0, 10)]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
              <ul className="mt-2 space-y-1.5">
                {g.hits.map((hit) => (
                  <li
                    key={`${hit.start_sec}-${hit.in_description}`}
                    className="text-sm text-gray-300"
                  >
                    <Link
                      to={askWatchPath(hit)}
                      className="mr-2 font-mono text-xs text-accent hover:underline"
                    >
                      {hit.in_description
                        ? "Description"
                        : formatTimestamp(hit.start_sec)}
                    </Link>
                    <Snippet text={hit.snippet} />
                  </li>
                ))}
              </ul>
            </div>
          </li>
        ))}
      </ul>
      {search.hasNextPage && (
        <div className="flex justify-center">
          <button
            type="button"
            className={button("secondary")}
            onClick={() => void search.fetchNextPage()}
            disabled={search.isFetchingNextPage}
          >
            {search.isFetchingNextPage ? "Loading…" : "Show more"}
          </button>
        </div>
      )}
    </>
  );
}
