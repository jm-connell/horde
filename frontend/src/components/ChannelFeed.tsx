import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import ChannelDownloadPanel from "./ChannelDownloadPanel";
import ChannelFeedCard from "./ChannelFeedCard";
import LoadingIndicator from "./LoadingIndicator";
import { useChannelDownloadQueue } from "../hooks/useChannelDownloadQueue";
import { useSettings } from "../hooks/useSettings";
import {
  feedSearchStatusLabel,
  formatSearchMatchCount,
  YOUTUBE_SEARCH_LOADING_LABEL,
  type FeedSearchPhase,
} from "../pages/libraryCatalogProgress";
import {
  applyChannelFeedSort,
  mergeYoutubeFeedEntries,
} from "./channelFeedYoutubeSearch";
import type { ChannelFeedEntry, ChannelStat, SearchMatchReason, Video } from "../types";

type FeedSort = "recent" | "popular";
type FeedLayout = "grid" | "list";

const PAGE_SIZE = 30;

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

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
    like_count: null,
    dislike_count: null,
    match_reason: v.match_reason ?? null,
  };
}

const MATCH_REASON_RANK: Record<string, number> = {
  captions: 4,
  description: 3,
  tags: 3,
  notes: 3,
  youtube: 2,
  related: 1,
  title: 0,
};

function pickMatchReason(
  a: SearchMatchReason | null | undefined,
  b: SearchMatchReason | null | undefined
): SearchMatchReason | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return (MATCH_REASON_RANK[b.source] ?? 0) > (MATCH_REASON_RANK[a.source] ?? 0)
    ? b
    : a;
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
        published_at: lib.published_at || existing.published_at,
        published_label: lib.published_at ? null : existing.published_label,
        view_count: existing.view_count ?? lib.view_count,
        duration: existing.duration ?? lib.duration,
        match_reason: pickMatchReason(existing.match_reason, lib.match_reason),
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
  catalogIndexing = false,
  queueDockedBottom = false,
  directYoutubeSearch = false,
}: {
  channel: string;
  channelUrl: string | null;
  channels: ChannelStat[];
  feedSearch: string;
  feedSort: FeedSort;
  feedOrder: "asc" | "desc";
  feedLayout: FeedLayout;
  showUndownloaded: boolean;
  catalogIndexing?: boolean;
  queueDockedBottom?: boolean;
  directYoutubeSearch?: boolean;
}) {
  const [settings] = useSettings();
  const [entries, setEntries] = useState<ChannelFeedEntry[]>([]);
  const [libraryEntries, setLibraryEntries] = useState<ChannelFeedEntry[]>([]);
  const [searchEntries, setSearchEntries] = useState<ChannelFeedEntry[] | null>(
    null
  );
  const [librarySearchEntries, setLibrarySearchEntries] = useState<
    ChannelFeedEntry[] | null
  >(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [searchPhase, setSearchPhase] = useState<FeedSearchPhase>("idle");
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchIndexing, setSearchIndexing] = useState(false);
  const [youtubeLoading, setYoutubeLoading] = useState(false);
  const [youtubeEntries, setYoutubeEntries] = useState<ChannelFeedEntry[]>([]);
  const [fromCatalog, setFromCatalog] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchAbort = useRef<AbortController | null>(null);
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

  /** Re-fetch catalog page so background view/vote enrichments show up. */
  const softMetaRefresh = useCallback(async () => {
    if (!channelUrl && !channel) return;
    const gen = liveRefreshGen.current;
    try {
      const page = await api.getChannelFeed({
        channel,
        url: channelUrl ?? undefined,
        offset: 0,
        limit: PAGE_SIZE,
        live: false,
      });
      if (gen !== liveRefreshGen.current) return;
      setEntries((prev) => {
        if (prev.length === 0) return page.entries;
        const byId = new Map(
          page.entries
            .filter((e) => e.id)
            .map((e) => [e.id as string, e] as const)
        );
        let changed = false;
        const next = prev.map((e) => {
          if (!e.id) return e;
          const fresh = byId.get(e.id);
          if (!fresh) return e;
          if (
            fresh.view_count === e.view_count &&
            fresh.like_count === e.like_count &&
            fresh.dislike_count === e.dislike_count &&
            fresh.published_at === e.published_at &&
            fresh.published_label === e.published_label
          ) {
            return e;
          }
          changed = true;
          return {
            ...e,
            view_count: fresh.view_count ?? e.view_count,
            like_count: fresh.like_count ?? e.like_count,
            dislike_count: fresh.dislike_count ?? e.dislike_count,
            published_at: fresh.published_at ?? e.published_at,
            published_label:
              fresh.published_at || fresh.published_label
                ? (fresh.published_label ?? null)
                : e.published_label,
          };
        });
        return changed ? next : prev;
      });
    } catch {
      /* ignore */
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
        if (!append) {
          const needsMeta = page.entries.some(
            (e) =>
              e.view_count == null ||
              e.like_count == null ||
              e.dislike_count == null
          );
          if (needsMeta) {
            window.setTimeout(() => void softMetaRefresh(), 4500);
            window.setTimeout(() => void softMetaRefresh(), 12000);
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load feed");
        if (!append) setEntries([]);
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [channel, channelUrl, softLiveRefresh, softMetaRefresh]
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
    setLibrarySearchEntries(null);
    setYoutubeEntries([]);
    setYoutubeLoading(false);
    setSearchPhase("idle");
    setSearchError(null);
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
    searchAbort.current?.abort();
    searchAbort.current = null;

    if (!q) {
      setSearchEntries(null);
      setLibrarySearchEntries(null);
      setYoutubeEntries([]);
      setYoutubeLoading(false);
      setSearchPhase("idle");
      setSearchError(null);
      setSearchIndexing(false);
      return;
    }

    setSearchPhase("keywords");
    setSearchError(null);
    setSearchEntries(null);
    setLibrarySearchEntries(null);
    setYoutubeEntries([]);
    setYoutubeLoading(false);

    searchTimer.current = setTimeout(() => {
      const ac = new AbortController();
      searchAbort.current = ac;
      const { signal } = ac;

      const keywordP = channelUrl
        ? api.searchChannelCatalog({
            q,
            channel,
            url: channelUrl,
            limit: 80,
            semantic: false,
            signal,
          })
        : Promise.resolve(null);

      const libraryP = api
        .listVideos({ channel, q, signal })
        .then((videos) => videos.map(videoToFeedEntry));
      void libraryP
        .then((lib) => {
          if (!signal.aborted) setLibrarySearchEntries(lib);
        })
        .catch((err) => {
          if (isAbortError(err) || signal.aborted) return;
          setLibrarySearchEntries([]);
        });

      const semanticP = channelUrl
        ? api.searchChannelCatalog({
            q,
            channel,
            url: channelUrl,
            limit: 80,
            semantic: true,
            signal,
          })
        : Promise.resolve(null);

      const runYoutube =
        directYoutubeSearch && q.length >= 2 && Boolean(channelUrl);
      if (runYoutube) {
        setYoutubeLoading(true);
        void api
          .searchChannelYoutube({
            q,
            channel,
            url: channelUrl ?? undefined,
            limit: 20,
            signal,
          })
          .then((page) => {
            if (signal.aborted) return;
            setYoutubeEntries(page.entries ?? []);
          })
          .catch((err) => {
            if (isAbortError(err) || signal.aborted) return;
            setYoutubeEntries([]);
          })
          .finally(() => {
            if (!signal.aborted) setYoutubeLoading(false);
          });
      }

      void (async () => {
        try {
          try {
            const keywordPage = await keywordP;
            if (signal.aborted) return;
            if (keywordPage) {
              setSearchEntries(keywordPage.entries);
              setSearchIndexing(Boolean(keywordPage.indexing));
            } else {
              setSearchEntries([]);
            }
          } catch (err) {
            if (isAbortError(err) || signal.aborted) return;
            setSearchError(
              err instanceof Error ? err.message : "Search failed"
            );
            setSearchEntries([]);
          }
          if (signal.aborted) return;
          setSearchPhase("related");

          try {
            const semanticPage = await semanticP;
            if (signal.aborted) return;
            if (semanticPage) {
              setSearchEntries(semanticPage.entries);
              setSearchIndexing(Boolean(semanticPage.indexing));
            }
          } catch (err) {
            if (isAbortError(err) || signal.aborted) return;
          }

          try {
            await libraryP;
          } catch {
            /* handled above */
          }
          if (signal.aborted) return;
          setSearchPhase("done");
        } catch (err) {
          if (isAbortError(err) || signal.aborted) return;
          setSearchError(
            err instanceof Error ? err.message : "Search failed"
          );
          setSearchEntries([]);
          setSearchPhase("done");
        }
      })();
    }, 250);

    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
      searchAbort.current?.abort();
    };
  }, [feedSearch, channel, channelUrl, directYoutubeSearch]);

  const filteredEntries = useMemo(() => {
    const q = feedSearch.trim();
    let list: ChannelFeedEntry[];
    if (!q) {
      list = mergeFeedWithLibrary(entries, libraryEntries);
    } else if (searchEntries != null || librarySearchEntries != null) {
      list = mergeFeedWithLibrary(
        searchEntries ?? [],
        librarySearchEntries ?? []
      );
    } else {
      list = [];
    }
    if (
      q &&
      youtubeEntries.length &&
      (searchEntries != null || librarySearchEntries != null)
    ) {
      list = mergeYoutubeFeedEntries(list, youtubeEntries);
    }
    if (!showUndownloaded) {
      list = list.filter(
        (e) => e.in_library || e.video_id != null || resolveVideoId(e) != null
      );
    }
    return applyChannelFeedSort(
      list,
      feedSort,
      feedOrder,
      q ? "search" : "browse"
    );
  }, [
    entries,
    libraryEntries,
    librarySearchEntries,
    searchEntries,
    youtubeEntries,
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

  const q = feedSearch.trim();
  const searchBusy =
    q.length > 0 && (searchPhase === "keywords" || searchPhase === "related");
  const searchStatusLabel = feedSearchStatusLabel(searchPhase);
  const waitingForFirstHits =
    q.length > 0 &&
    filteredEntries.length === 0 &&
    (searchBusy || youtubeLoading);
  const indexIncomplete = q.length > 0 && (catalogIndexing || searchIndexing);
  const showFeedLoading = Boolean(loading && channelUrl && !q);
  const showSearchBanner =
    q.length > 0 &&
    !waitingForFirstHits &&
    (searchBusy ||
      youtubeLoading ||
      filteredEntries.length > 0 ||
      indexIncomplete);

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

      {searchError && (
        <p className="mb-4 rounded-lg bg-red-500/10 px-4 py-3 text-sm text-red-400">
          {searchError}
        </p>
      )}

      {showSearchBanner && (
        <div
          className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500"
          role="status"
          aria-live="polite"
        >
          {searchBusy && searchStatusLabel && (
            <LoadingIndicator
              className="py-0"
              label={searchStatusLabel}
              labelVisible
            />
          )}
          {filteredEntries.length > 0 && (
            <span>{formatSearchMatchCount(filteredEntries.length)}</span>
          )}
          {youtubeLoading && filteredEntries.length > 0 && (
            <span>{YOUTUBE_SEARCH_LOADING_LABEL}</span>
          )}
          {indexIncomplete && (
            <span>Index still running — results may be incomplete.</span>
          )}
        </div>
      )}

      {waitingForFirstHits ? (
        <LoadingIndicator
          label={
            searchBusy
              ? searchStatusLabel || "Searching indexed catalog…"
              : YOUTUBE_SEARCH_LOADING_LABEL
          }
          labelVisible
        />
      ) : showFeedLoading ? (
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
                  searchQuery={feedSearch}
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
