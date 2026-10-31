import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { button } from "../../components/buttons";
import LoadingIndicator from "../../components/LoadingIndicator";
import { useAskSearch } from "../../queries/ask";
import type { AskChannel, AskSearchHit } from "../../types";
import { formatTimestamp, youtubeListThumbnailUrl } from "../../utils";
import { askWatchPath, snippetParts } from "./askLinks";

interface VideoGroup {
  yt_id: string;
  title: string | null | undefined;
  channel: string | null | undefined;
  published: string | null | undefined;
  hits: AskSearchHit[];
}

function groupByVideo(hits: AskSearchHit[]): VideoGroup[] {
  const groups = new Map<string, VideoGroup>();
  for (const hit of hits) {
    let group = groups.get(hit.yt_id);
    if (!group) {
      group = {
        yt_id: hit.yt_id,
        title: hit.title,
        channel: hit.channel_name,
        published: hit.published_at,
        hits: [],
      };
      groups.set(hit.yt_id, group);
    }
    group.hits.push(hit);
  }
  return [...groups.values()];
}

function Snippet({ text }: { text: string }) {
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

/** Find where channels said something: passages grouped by video, each a link to the moment. */
export default function AskSearch({ channels }: { channels: AskChannel[] }) {
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [channelId, setChannelId] = useState<number | null>(null);
  const channelIds = useMemo(
    () => (channelId == null ? [] : [channelId]),
    [channelId]
  );
  const search = useAskSearch(query, channelIds);
  const groups = useMemo(() => groupByVideo(search.hits), [search.hits]);

  return (
    <section aria-labelledby="ask-search-title" className="space-y-4">
      <h2
        id="ask-search-title"
        className="text-sm font-semibold tracking-wide text-gray-300"
      >
        Search what was said
      </h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setQuery(draft.trim());
        }}
        className="flex flex-wrap gap-2"
      >
        <label htmlFor="ask-search-q" className="sr-only">
          Words to find
        </label>
        <input
          id="ask-search-q"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder='Words or "a phrase"'
          className="min-w-0 flex-1 rounded-lg bg-ink-800 px-3 py-2 text-sm text-gray-100 ring-1 ring-ink-700 placeholder:text-muted focus:outline-none focus:ring-accent"
        />
        <label htmlFor="ask-search-channel" className="sr-only">
          Channel
        </label>
        <select
          id="ask-search-channel"
          value={channelId ?? ""}
          onChange={(e) =>
            setChannelId(e.target.value ? Number(e.target.value) : null)
          }
          className="rounded-lg bg-ink-800 px-3 py-2 text-sm text-gray-100 ring-1 ring-ink-700"
        >
          <option value="">All channels</option>
          {channels.map((c) => (
            <option key={c.id} value={c.id}>
              {c.channel_name || c.channel_url}
            </option>
          ))}
        </select>
        <button
          type="submit"
          className={button("primary")}
          disabled={!draft.trim()}
        >
          Search
        </button>
      </form>

      {search.isLoading && <LoadingIndicator />}
      {query && !search.isLoading && groups.length === 0 && (
        <p className="text-sm text-muted">
          Nothing in the indexed captions mentions that.
        </p>
      )}
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
                className="h-16 w-28 rounded-md object-cover"
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
        <button
          type="button"
          className={button("secondary", "sm")}
          onClick={() => void search.fetchNextPage()}
          disabled={search.isFetchingNextPage}
        >
          {search.isFetchingNextPage ? "Loading…" : "Show more"}
        </button>
      )}
    </section>
  );
}
