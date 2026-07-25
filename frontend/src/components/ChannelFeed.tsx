import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import ChannelDownloadPanel from "./ChannelDownloadPanel";
import ChannelFeedCard from "./ChannelFeedCard";
import LoadingIndicator from "./LoadingIndicator";
import { useChannelDownloadQueue } from "../hooks/useChannelDownloadQueue";
import { useSettings } from "../hooks/useSettings";
import type { ChannelFeedEntry, ChannelStat, Video } from "../types";

type FeedSort = "recent" | "popular";
type FeedLayout = "grid" | "list";

const PAGE_SIZE = 30;

function extractYoutubeId(url: string | null | undefined): string | null {
  if (!url) return null;
  const watch = url.match(/[?&]v=([\w-]{11})/);
  if (watch) return watch[1];
  const short = url.match(/youtu\.be\/([\w-]{11})/);
  if (short) return short[1];
  return null;
}

function videoToFeedEntry(v: Video): ChannelFeedEntry {
  return {
    id: extractYoutubeId(v.source_url),
    url: v.source_url || "",
    title: v.title,
    duration: v.duration_sec,
    thumbnail_url: null,
    view_count: v.view_count,
    published_at: v.published_at,
    in_library: true,
    video_id: v.id,
    library_height_px: v.height_px,
    max_height: null,
  };
}

/** Union by youtube id then title; feed entries win for metadata. */
function mergeFeedWithLibrary(
  feed: ChannelFeedEntry[],
  library: ChannelFeedEntry[]
): ChannelFeedEntry[] {
  const byId = new Map<string, number>();
  const byTitle = new Map<string, number>();
  const result: ChannelFeedEntry[] = [];

  for (const e of feed) {
    const idx = result.length;
    result.push({ ...e });
    if (e.id) byId.set(e.id, idx);
    if (e.title) byTitle.set(e.title.toLowerCase(), idx);
  }

  for (const lib of library) {
    const idIdx = lib.id ? byId.get(lib.id) : undefined;
    const titleIdx =
      idIdx === undefined && lib.title
        ? byTitle.get(lib.title.toLowerCase())
        : undefined;
    const hit = idIdx ?? titleIdx;
    if (hit !== undefined) {
      const existing = result[hit];
      result[hit] = {
        ...existing,
        in_library: true,
        video_id: lib.video_id ?? existing.video_id,
        library_height_px:
          lib.library_height_px ?? existing.library_height_px,
      };
      continue;
    }
    const idx = result.length;
    result.push({ ...lib });
    if (lib.id) byId.set(lib.id, idx);
    if (lib.title) byTitle.set(lib.title.toLowerCase(), idx);
  }

  return result;
}

export default function ChannelFeed({
  channel,
  channelUrl,
  channels,
  feedSearch,
  feedSort,
  feedOrder,
  feedLayout,
  showUndownloaded,
  queueDockedBottom = false,
}: {
  channel: string;
  channelUrl: string | null;
  channels: ChannelStat[];
  feedSearch: string;
  feedSort: FeedSort;
  feedOrder: "asc" | "desc";
  feedLayout: FeedLayout;
  showUndownloaded: boolean;
  queueDockedBottom?: boolean;
}) {
  const [settings] = useSettings();
  const [entries, setEntries] = useState<ChannelFeedEntry[]>([]);
  const [libraryEntries, setLibraryEntries] = useState<ChannelFeedEntry[]>([]);
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
    let cancelled = false;
    setLibraryEntries([]);
    api
      .listVideos({ channel })
      .then((videos) => {
        if (!cancelled) setLibraryEntries(videos.map(videoToFeedEntry));
      })
      .catch(() => {
        if (!cancelled) setLibraryEntries([]);
      });
    return () => {
      cancelled = true;
    };
  }, [channel]);

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
    const libraryForQuery = q
      ? libraryEntries.filter((e) =>
          (e.title ?? "").toLowerCase().includes(q)
        )
      : libraryEntries;
    let list =
      q && searchEntries != null
        ? mergeFeedWithLibrary(searchEntries, libraryForQuery)
        : q
          ? mergeFeedWithLibrary(entries, libraryEntries).filter((e) =>
              (e.title ?? "").toLowerCase().includes(q)
            )
          : mergeFeedWithLibrary(entries, libraryEntries);
    if (!showUndownloaded) {
      list = list.filter(
        (e) => e.in_library || e.video_id != null || resolveVideoId(e) != null
      );
    }
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
  }, [
    entries,
    libraryEntries,
    searchEntries,
    feedSearch,
    feedSort,
    feedOrder,
    showUndownloaded,
    resolveVideoId,
  ]);

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

  if (!channelUrl && libraryEntries.length === 0 && !loading) {
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

      {loading && channelUrl ? (
        <LoadingIndicator label="Loading channel feed" />
      ) : filteredEntries.length === 0 ? (
        <div className="py-20 text-center text-gray-500">
          <p className="text-lg">No videos found</p>
          <p className="mt-1 text-sm">
            {feedSearch
              ? "Try a different search term."
              : !channelUrl
                ? "No YouTube URL is known for this channel yet."
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
                  key={entry.url || String(entry.video_id ?? entry.id)}
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
