import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import ChannelDownloadPanel from "./ChannelDownloadPanel";
import ChannelFeedCard from "./ChannelFeedCard";
import LoadingIndicator from "./LoadingIndicator";
import { useChannelDownloadQueue } from "../hooks/useChannelDownloadQueue";
import { useSettings } from "../hooks/useSettings";
import type { ChannelFeedEntry, ChannelStat } from "../types";

type FeedSort = "recent" | "popular";
type FeedLayout = "grid" | "list";

const PAGE_SIZE = 30;

export default function ChannelFeed({
  channel,
  channelUrl,
  channels,
  feedSearch,
  feedSort,
  feedOrder,
  feedLayout,
  queueDockedBottom = false,
}: {
  channel: string;
  channelUrl: string | null;
  channels: ChannelStat[];
  feedSearch: string;
  feedSort: FeedSort;
  feedOrder: "asc" | "desc";
  feedLayout: FeedLayout;
  queueDockedBottom?: boolean;
}) {
  const [settings] = useSettings();
  const [entries, setEntries] = useState<ChannelFeedEntry[]>([]);
  const [searchEntries, setSearchEntries] = useState<ChannelFeedEntry[] | null>(
    null
  );
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const [fromCatalog, setFromCatalog] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const liveRefreshGen = useRef(0);

  const {
    defaultPreset,
    setDefaultPreset,
    allPresets,
    pending,
    editingId,
    setEditingId,
    queueDownload,
    cancelPending,
    updatePending,
    submitNow,
    isQueuedOrLibrary,
    resolveVideoId,
  } = useChannelDownloadQueue(channel);

  const [panelDismissed, setPanelDismissed] = useState(false);

  const softLiveRefresh = useCallback(async () => {
    if (!channelUrl && !channel) return;
    const gen = ++liveRefreshGen.current;
    try {
      const page = await api.getChannelFeed({
        channel,
        url: channelUrl ?? undefined,
        offset: 0,
        limit: PAGE_SIZE,
        live: true,
      });
      if (gen !== liveRefreshGen.current) return;
      setEntries((prev) => {
        if (prev.length <= PAGE_SIZE) return page.entries;
        const rest = prev.slice(PAGE_SIZE);
        const headIds = new Set(
          page.entries.map((e) => e.id).filter(Boolean) as string[]
        );
        const filteredRest = rest.filter(
          (e) => !e.id || !headIds.has(e.id)
        );
        return [...page.entries, ...filteredRest];
      });
      setHasMore((prevHasMore) => page.has_more || prevHasMore);
      setFromCatalog(Boolean(page.from_catalog));
    } catch {
      /* keep catalog paint */
    }
  }, [channel, channelUrl]);

  const loadPage = useCallback(
    async (offset: number, append: boolean) => {
      if (!channelUrl && !channel) return;
      if (append) setLoadingMore(true);
      else setLoading(true);
      setError(null);
      try {
        const page = await api.getChannelFeed({
          channel,
          url: channelUrl ?? undefined,
          offset,
          limit: PAGE_SIZE,
          live: false,
        });
        setEntries((prev) =>
          append ? [...prev, ...page.entries] : page.entries
        );
        setHasMore(page.has_more);
        const usedCatalog = Boolean(page.from_catalog);
        if (!append) setFromCatalog(usedCatalog);
        // Catalog painted — pull newest uploads / metadata without blocking UI.
        if (!append && usedCatalog) {
          void softLiveRefresh();
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load feed");
        if (!append) setEntries([]);
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [channel, channelUrl, softLiveRefresh]
  );

  useEffect(() => {
    setEntries([]);
    setSearchEntries(null);
    setHasMore(false);
    setFromCatalog(false);
    liveRefreshGen.current += 1;
    if (!channelUrl) {
      setLoading(false);
      return;
    }
    void loadPage(0, false);
  }, [channel, channelUrl, loadPage]);

  useEffect(() => {
    const q = feedSearch.trim();
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (!q || !channelUrl) {
      setSearchEntries(null);
      setSearchLoading(false);
      return;
    }
    setSearchLoading(true);
    searchTimer.current = setTimeout(() => {
      api
        .searchChannelCatalog({
          q,
          channel,
          url: channelUrl,
          limit: 80,
        })
        .then((page) => {
          setSearchEntries(page.entries);
        })
        .catch(() => {
          setSearchEntries(null);
        })
        .finally(() => setSearchLoading(false));
    }, 250);
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [feedSearch, channel, channelUrl]);

  const filteredEntries = useMemo(() => {
    const q = feedSearch.trim().toLowerCase();
    let list =
      q && searchEntries != null
        ? searchEntries
        : q
          ? entries.filter((e) => (e.title ?? "").toLowerCase().includes(q))
          : entries;
    if (feedSort === "popular") {
      list = [...list].sort((a, b) => {
        const av = a.view_count ?? -1;
        const bv = b.view_count ?? -1;
        return feedOrder === "desc" ? bv - av : av - bv;
      });
    } else if (feedOrder === "asc") {
      list = [...list].reverse();
    }
    return list;
  }, [entries, searchEntries, feedSearch, feedSort, feedOrder]);

  const canLoadMore =
    hasMore && !feedSearch.trim() && !loading && !loadingMore;

  useEffect(() => {
    const el = loadMoreRef.current;
    if (!el || !canLoadMore) return;
    const observer = new IntersectionObserver(
      ([hit]) => {
        if (hit?.isIntersecting) {
          void loadPage(entries.length, true);
        }
      },
      { rootMargin: "400px" }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [canLoadMore, entries.length, loadPage]);

  const pendingUrls = useMemo(
    () => new Set(pending.map((p) => p.entry.url)),
    [pending]
  );

  if (!channelUrl) {
    return (
      <div className="py-20 text-center text-gray-500">
        <p className="text-lg">Channel feed unavailable</p>
        <p className="mt-1 text-sm">
          No YouTube URL is known for this channel yet. Download a video from
          this channel first, or resync metadata on an existing video.
        </p>
      </div>
    );
  }

  return (
    <>
      {error && (
        <p className="mb-4 rounded-lg bg-red-500/10 px-4 py-3 text-sm text-red-400">
          {error}
        </p>
      )}

      {(searchLoading) && (
        <p className="mb-3 text-xs text-gray-500">
          Searching indexed catalog…
        </p>
      )}

      {loading ? (
        <LoadingIndicator label="Loading channel feed" />
      ) : filteredEntries.length === 0 ? (
        <div className="py-20 text-center text-gray-500">
          <p className="text-lg">No videos found</p>
          <p className="mt-1 text-sm">
            {feedSearch
              ? "Try a different search term."
              : "This channel has no public uploads, or they could not be loaded."}
          </p>
        </div>
      ) : (
        <>
          <div
            className={
              feedLayout === "grid"
                ? `grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 ${
                    settings.sidebarCollapsed ? "xl:grid-cols-5" : "xl:grid-cols-4"
                  }`
                : "mx-auto flex w-full max-w-3xl flex-col gap-2"
            }
          >
            {filteredEntries.map((entry) => {
              const inLibrary = isQueuedOrLibrary(entry);
              const videoId = resolveVideoId(entry);
              return (
                <ChannelFeedCard
                  key={entry.url}
                  entry={entry}
                  channelName={channel}
                  layout={feedLayout}
                  inLibrary={inLibrary}
                  videoId={videoId ?? undefined}
                  downloading={pendingUrls.has(entry.url)}
                  onDownload={() => queueDownload(entry)}
                  skipRemotePreview={fromCatalog}
                />
              );
            })}
          </div>
          <div ref={loadMoreRef} className="h-1" aria-hidden />
          {loadingMore && (
            <LoadingIndicator label="Loading more" className="py-6" />
          )}
        </>
      )}

      {!panelDismissed && (
        <ChannelDownloadPanel
          defaultPreset={defaultPreset}
          onDefaultPresetChange={setDefaultPreset}
          allPresets={allPresets}
          pending={pending}
          channels={channels}
          editingId={editingId}
          onSetEditingId={setEditingId}
          onUpdatePending={updatePending}
          onCancel={cancelPending}
          onSubmitNow={submitNow}
          queueDockedBottom={queueDockedBottom}
          onDismiss={() => setPanelDismissed(true)}
        />
      )}
    </>
  );
}
