import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { button } from "../components/buttons";
import ChannelFeedCard from "../components/ChannelFeedCard";
import ConfirmDialog from "../components/ConfirmDialog";
import { CheckIcon } from "../components/icons";
import LoadingIndicator from "../components/LoadingIndicator";
import VideoCard from "../components/VideoCard";
import { useDownloads } from "../context/DownloadContext";
import { useToast } from "../context/ToastContext";
import {
  useHistoryWatches,
  useRemoveHistory,
  useSetHistoryTaste,
} from "../queries/history";
import type { HistoryWatch } from "../types";
import HistoryMenu from "./history/HistoryMenu";
import HistoryStatsBand from "./history/HistoryStatsBand";

/** Parse API datetimes as UTC when no timezone is present (legacy naive strings). */
function parseUtc(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const raw = iso.trim();
  if (!raw) return null;
  const hasTz = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw);
  const normalized = hasTz ? raw : `${raw.replace(/ /, "T")}Z`;
  const d = new Date(normalized);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function dayKey(iso: string | null | undefined): string {
  const d = parseUtc(iso);
  if (!d) return "unknown";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function dayLabel(key: string): string {
  if (key === "unknown") return "Unknown";
  const [y, m, d] = key.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const target = new Date(date);
  target.setHours(0, 0, 0, 0);
  if (target.getTime() === today.getTime()) return "Today";
  if (target.getTime() === yesterday.getTime()) return "Yesterday";
  return date.toLocaleDateString(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric",
    year: date.getFullYear() !== today.getFullYear() ? "numeric" : undefined,
  });
}

function formatTime(iso: string | null | undefined): string {
  const d = parseUtc(iso);
  if (!d) return "";
  return d.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

const SOURCE_NOTE: Record<HistoryWatch["sources"][number], string> = {
  library: "",
  stream: "Streamed",
  youtube: "On YouTube",
};

function titleOf(entry: HistoryWatch): string {
  return entry.video?.title ?? entry.stream?.title ?? "This video";
}

/** A line under the card: when, and where it was watched if not here. */
function WatchLine({ entry }: { entry: HistoryWatch }) {
  const where = SOURCE_NOTE[entry.sources[0] ?? "library"];
  const views =
    entry.youtube_views > 1 ? ` · ${entry.youtube_views} views on YouTube` : "";
  return (
    <p className="flex flex-wrap items-center gap-x-2 px-1 text-xs text-muted">
      <span>{formatTime(entry.watched_at)}</span>
      {where && <span>· {where}</span>}
      {views && <span>{views.slice(3)}</span>}
      {entry.excluded && (
        <span className="text-gray-300">· Not used for recommendations</span>
      )}
    </p>
  );
}

type Confirm = { keys: string[]; label: string } | null;

/**
 * Everything you watched, newest first, one card per video: library videos,
 * videos played without downloading, and your imported YouTube history.
 * Remove videos (they count as unwatched again) or keep them out of your
 * recommendations, one at a time from a card's menu or many at once in
 * Select mode.
 */
export default function History() {
  const { showToast, showError } = useToast();
  const { submitDownload } = useDownloads();
  const query = useHistoryWatches();
  const remove = useRemoveHistory();
  const taste = useSetHistoryTaste();
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [downloading, setDownloading] = useState<Set<string>>(new Set());
  const sentinelRef = useRef<HTMLDivElement>(null);

  // Pages are by offset: a watch recorded while scrolling can repeat one.
  const entries = useMemo(() => {
    const seen = new Set<string>();
    return (query.data?.pages.flatMap((p) => p.items) ?? []).filter((e) => {
      if (seen.has(e.key)) return false;
      seen.add(e.key);
      return true;
    });
  }, [query.data]);
  const total = query.data?.pages[0]?.total ?? entries.length;

  const groups = useMemo(() => {
    const map = new Map<string, HistoryWatch[]>();
    for (const e of entries) {
      const key = dayKey(e.watched_at);
      const list = map.get(key);
      if (list) list.push(e);
      else map.set(key, [e]);
    }
    return Array.from(map.entries());
  }, [entries]);

  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasNextPage) return;
    const io = new IntersectionObserver(
      (seen) => {
        if (seen.some((s) => s.isIntersecting) && !isFetchingNextPage)
          void fetchNextPage();
      },
      { rootMargin: "400px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const toggle = useCallback((key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const stopSelecting = () => {
    setSelecting(false);
    setSelected(new Set());
  };

  const setUse = (keys: string[], use: boolean) => {
    taste.mutate(
      { keys, use },
      {
        onSuccess: () => {
          showToast(
            use
              ? keys.length === 1
                ? "This shapes your recommendations again"
                : `${keys.length} videos shape your recommendations again`
              : keys.length === 1
                ? "This no longer shapes your recommendations"
                : `${keys.length} videos no longer shape your recommendations`,
            {
              action: {
                label: "Undo",
                onClick: () => taste.mutate({ keys, use: !use }),
              },
            }
          );
          if (selecting) stopSelecting();
        },
        onError: () => showError("Could not save that"),
      }
    );
  };

  const doRemove = () => {
    if (!confirm) return;
    const { keys } = confirm;
    remove.mutate(keys, {
      onSuccess: () => {
        setConfirm(null);
        showToast(
          keys.length === 1
            ? "Removed from your history"
            : `${keys.length} videos removed from your history`
        );
        if (selecting) stopSelecting();
      },
      onError: () => showError("Could not remove that"),
    });
  };

  const downloadStream = (entry: HistoryWatch) => {
    const stream = entry.stream;
    if (!stream?.url || downloading.has(stream.url)) return;
    setDownloading((prev) => new Set(prev).add(stream.url));
    void submitDownload(stream.url, "1080p", {
      title: stream.title ?? undefined,
      channel: stream.channel ?? "Unknown channel",
    })
      .then(() => showToast("Download queued"))
      .catch((err: unknown) =>
        showError(
          err instanceof Error ? err.message : "Could not start download"
        )
      )
      .finally(() =>
        setDownloading((prev) => {
          const next = new Set(prev);
          next.delete(stream.url);
          return next;
        })
      );
  };

  const selectedKeys = [...selected];
  const card = (entry: HistoryWatch) => {
    const isSelected = selected.has(entry.key);
    const title = titleOf(entry);
    return (
      <div
        key={entry.key}
        className="group/hist relative flex flex-col gap-1"
        data-history-key={entry.key}
      >
        <div
          className={`relative transition-opacity duration-200 ${entry.excluded ? "opacity-50" : ""}`}
          // Selecting: the card's own links and buttons are out of reach.
          inert={selecting}
        >
          {entry.video ? (
            <VideoCard video={entry.video} />
          ) : entry.stream ? (
            <ChannelFeedCard
              entry={entry.stream}
              channelName={entry.stream.channel || "Unknown channel"}
              layout="grid"
              inLibrary={false}
              onDownload={() => downloadStream(entry)}
              downloading={downloading.has(entry.stream.url)}
              skipRemotePreview
            />
          ) : null}
        </div>
        <WatchLine entry={entry} />
        {selecting ? (
          <button
            type="button"
            aria-pressed={isSelected}
            aria-label={`Select ${title}`}
            onClick={() => toggle(entry.key)}
            className={`absolute inset-0 z-10 rounded-xl ring-2 transition-colors ${
              isSelected
                ? "bg-accent/10 ring-accent"
                : "ring-transparent hover:ring-accent/50"
            }`}
          >
            <span
              aria-hidden="true"
              className={`absolute left-2 top-2 flex h-6 w-6 items-center justify-center rounded-full border ${
                isSelected
                  ? "border-accent bg-accent text-on-accent"
                  : "border-gray-300 bg-ink-950/70"
              }`}
            >
              {isSelected && <CheckIcon className="h-4 w-4" />}
            </span>
          </button>
        ) : (
          <HistoryMenu
            title={title}
            excluded={entry.excluded}
            onTaste={() => setUse([entry.key], entry.excluded)}
            onRemove={() =>
              setConfirm({ keys: [entry.key], label: `“${title}”` })
            }
            className="absolute right-2 top-2 z-10 opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover/hist:opacity-100 [@media(hover:none)]:opacity-100"
          />
        )}
      </div>
    );
  };

  return (
    <div className={selecting ? "pb-44 sm:pb-24" : undefined}>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-gray-100">History</h1>
        {entries.length > 0 && (
          <button
            type="button"
            aria-pressed={selecting}
            onClick={() => (selecting ? stopSelecting() : setSelecting(true))}
            className={button("secondary", "sm")}
          >
            {selecting ? "Done" : "Select"}
          </button>
        )}
      </div>
      <HistoryStatsBand />

      {query.isLoading ? (
        <LoadingIndicator />
      ) : query.isError ? (
        <div className="py-20 text-center text-muted">
          <p className="text-sm">Could not load your history.</p>
        </div>
      ) : entries.length === 0 ? (
        <div className="py-20 text-center text-muted">
          <p className="text-lg">No watch history yet.</p>
          <p className="mt-1 text-sm">Videos you watch will appear here.</p>
        </div>
      ) : (
        <div className="space-y-8">
          {groups.map(([key, dayEntries]) => {
            const dayKeys = dayEntries.map((e) => e.key);
            const allPicked = dayKeys.every((k) => selected.has(k));
            return (
              <section key={key} aria-labelledby={`history-day-${key}`}>
                <div className="mb-4 flex items-center gap-3">
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full bg-accent/80 ring-2 ring-accent/25"
                    aria-hidden
                  />
                  <h2
                    id={`history-day-${key}`}
                    className="shrink-0 text-sm font-semibold tracking-wide text-gray-300"
                  >
                    {dayLabel(key)}
                  </h2>
                  <hr className="min-w-0 flex-1 border-0 border-t border-ink-700" />
                  {selecting && (
                    <button
                      type="button"
                      onClick={() =>
                        setSelected((prev) => {
                          const next = new Set(prev);
                          for (const k of dayKeys) {
                            if (allPicked) next.delete(k);
                            else next.add(k);
                          }
                          return next;
                        })
                      }
                      className="shrink-0 text-xs text-muted hover:text-accent"
                    >
                      {allPicked ? "Unselect day" : "Select day"}
                    </button>
                  )}
                </div>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
                  {dayEntries.map(card)}
                </div>
              </section>
            );
          })}
          <div ref={sentinelRef} className="h-4" />
          {isFetchingNextPage && <LoadingIndicator />}
        </div>
      )}

      {selecting && (
        <div
          className="ui-panel ui-panel-legible fixed inset-x-0 bottom-0 z-40 border border-ink-700 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] transition-[opacity,translate] duration-200 ease-fluid starting:translate-y-full starting:opacity-0 motion-reduce:starting:translate-y-0"
          data-horde="history-bulk-bar"
        >
          <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-3">
            <span
              className="text-sm font-medium text-gray-300"
              aria-live="polite"
            >
              {selected.size} of {total} selected
            </span>
            <button
              type="button"
              onClick={() =>
                setSelected(
                  selected.size === entries.length
                    ? new Set()
                    : new Set(entries.map((e) => e.key))
                )
              }
              className={button("quiet", "sm")}
            >
              {selected.size === entries.length
                ? "Select none"
                : "Select all shown"}
            </button>
            <span className="flex-1" />
            <button
              type="button"
              disabled={!selected.size || taste.isPending}
              onClick={() => setUse(selectedKeys, false)}
              className={button("secondary", "sm")}
            >
              Don&apos;t use for recommendations
            </button>
            <button
              type="button"
              disabled={!selected.size || taste.isPending}
              onClick={() => setUse(selectedKeys, true)}
              className={button("secondary", "sm")}
            >
              Use for recommendations
            </button>
            <button
              type="button"
              disabled={!selected.size}
              onClick={() =>
                setConfirm({
                  keys: selectedKeys,
                  label:
                    selectedKeys.length === 1
                      ? "1 video"
                      : `${selectedKeys.length} videos`,
                })
              }
              className={button("danger", "sm")}
            >
              Remove from history
            </button>
            <button
              type="button"
              onClick={stopSelecting}
              className={button("quiet", "sm")}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {confirm && (
        <ConfirmDialog
          title={`Remove ${confirm.label} from your history?`}
          body={`${confirm.keys.length === 1 ? "It counts" : "They count"} as unwatched again: ${confirm.keys.length === 1 ? "it" : "they"} may be recommended and leave Continue watching. Views imported from YouTube are removed too; your watch time totals stay. This cannot be undone.`}
          confirmLabel="Remove"
          danger
          busy={remove.isPending}
          busyLabel="Removing…"
          onCancel={() => setConfirm(null)}
          onConfirm={doRemove}
        />
      )}
    </div>
  );
}
