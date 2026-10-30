import { useState } from "react";
import { Link } from "react-router-dom";
import { useDownloads } from "../../context/DownloadContext";
import { useToast } from "../../context/ToastContext";
import { useRewatched } from "../../queries/takeout";
import type { RewatchedVideo } from "../../types";
import { youtubeThumbnailUrl } from "../../utils";
import { watchHref } from "../../utils/watchHref";
import { button } from "../buttons";
import Collapse from "../Collapse";
import { ChevronIcon } from "../icons";

function lastWatched(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleDateString(undefined, { month: "short", year: "numeric" });
}

/**
 * Below the download form, folded away: videos the user watched several times
 * on YouTube (their Takeout import) that are not downloaded. Hidden when there
 * are none.
 */
export default function RewatchedSuggestions() {
  const [open, setOpen] = useState(false);
  const query = useRewatched();
  const { submitDownload } = useDownloads();
  const { showToast, showError } = useToast();
  const [queued, setQueued] = useState<Set<string>>(new Set());
  const items = query.data?.pages.flatMap((p) => p.items) ?? [];
  if (items.length === 0) return null;

  const download = (item: RewatchedVideo) => {
    const { entry } = item;
    setQueued((prev) => new Set(prev).add(entry.url));
    submitDownload(entry.url, "1080p", {
      title: entry.title ?? undefined,
      channel: entry.channel ?? "Unknown channel",
    })
      .then(() => showToast("Download queued"))
      .catch((err: unknown) => {
        setQueued((prev) => {
          const next = new Set(prev);
          next.delete(entry.url);
          return next;
        });
        showError(
          err instanceof Error ? err.message : "Could not start download"
        );
      });
  };

  return (
    <section className="mt-2 text-sm" aria-label="Watched often on YouTube">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="rewatched-suggestions"
        className="ui-interactive flex min-h-11 items-center gap-2 rounded-lg px-2 text-left text-gray-400 hover:text-gray-200"
      >
        <ChevronIcon
          className={`transition-transform duration-200 ease-fluid ${open ? "" : "-rotate-90"}`}
        />
        Watched often on YouTube
        <span className="rounded-full bg-ink-800 px-2 py-0.5 text-xs text-muted">
          {items.length}
          {query.hasNextPage ? "+" : ""}
        </span>
      </button>
      <Collapse open={open}>
        <div
          id="rewatched-suggestions"
          className="ui-panel rounded-xl bg-ink-900 p-2 ring-1 ring-ink-700"
        >
          <p className="px-2 pt-1 pb-2 text-xs text-muted">
            You came back to these on YouTube but don’t have them here yet.
          </p>
          <ul>
            {items.map((item) => {
              const { entry } = item;
              const href = watchHref(entry, entry.channel ?? "");
              const thumb = youtubeThumbnailUrl(entry.id, entry.thumbnail_url);
              const isQueued = queued.has(entry.url);
              return (
                <li
                  key={entry.id ?? entry.url}
                  className="flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-ink-800"
                >
                  {thumb && (
                    <img
                      src={thumb}
                      alt=""
                      loading="lazy"
                      decoding="async"
                      className="aspect-video w-24 shrink-0 rounded-md bg-ink-800 object-cover"
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    {href ? (
                      <Link
                        to={href}
                        className="line-clamp-2 text-sm text-gray-200 hover:text-accent"
                      >
                        {entry.title || "Untitled video"}
                      </Link>
                    ) : (
                      <span className="line-clamp-2 text-sm text-gray-200">
                        {entry.title || "Untitled video"}
                      </span>
                    )}
                    <p className="truncate text-xs text-muted">
                      {[
                        entry.channel,
                        `watched ${item.views} times`,
                        lastWatched(item.last_watched_at) &&
                          `last ${lastWatched(item.last_watched_at)}`,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  </div>
                  <button
                    type="button"
                    className={`${button("secondary", "xs")} shrink-0`}
                    disabled={isQueued}
                    onClick={() => download(item)}
                  >
                    {isQueued ? "Queued" : "Download"}
                  </button>
                </li>
              );
            })}
          </ul>
          {query.hasNextPage && (
            <button
              type="button"
              className={`${button("quiet", "xs")} mx-2 my-1`}
              disabled={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              {query.isFetchingNextPage ? "Loading…" : "Show more"}
            </button>
          )}
        </div>
      </Collapse>
    </section>
  );
}
