import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, downloadFileUrl } from "../api";
import ContinueWatchingRow from "../components/ContinueWatchingRow";
import ChannelFeed from "../components/ChannelFeed";
import PlaybackQueue from "../components/PlaybackQueue";
import VideoCard from "../components/VideoCard";
import { useDownloads } from "../context/DownloadContext";
import { usePlayback } from "../context/PlaybackContext";
import { useSearch } from "../context/SearchContext";
import { useContinueWatchingDismiss } from "../hooks/useContinueWatchingDismiss";
import {
  LIBRARY_SORT_OPTIONS,
  loadLibrarySort,
  saveLibrarySort,
  type LibrarySort,
  type LibrarySortState,
} from "../hooks/useLibrarySort";
import { loadSettings, useSettings } from "../hooks/useSettings";
import { useToast } from "../context/ToastContext";
import type { ChannelStat, Playlist, TagStat, Video } from "../types";

const TAG_MIN_COUNT = 3;
const TAG_PAGE_SIZE = 20;
const FEED_LAYOUT_KEY = "horde.channelFeed.layout";
// Fixed queue overlay width (w-[26rem]) — dock to bottom when grid extends into this zone.
const QUEUE_RESERVE_PX = 416;

function loadFeedLayout(): "grid" | "list" {
  try {
    return localStorage.getItem(FEED_LAYOUT_KEY) === "list" ? "list" : "grid";
  } catch {
    return "grid";
  }
}

function videoProgress(video: Video): number | undefined {
  if (!video.duration_sec || video.duration_sec <= 0) return undefined;
  if (video.last_position_sec <= 0) return undefined;
  return Math.min(1, video.last_position_sec / video.duration_sec);
}

export default function Library() {
  const [videos, setVideos] = useState<Video[]>([]);
  const [continueWatching, setContinueWatching] = useState<Video[]>([]);
  const [channels, setChannels] = useState<ChannelStat[]>([]);
  const [tags, setTags] = useState<TagStat[]>([]);
  const [showTags, setShowTags] = useState(false);
  const [showAllTags, setShowAllTags] = useState(false);
  const [loading, setLoading] = useState(true);

  // Multi-select state
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const lastSelectedIndex = useRef<number | null>(null);
  const mainContentRef = useRef<HTMLDivElement>(null);
  const [queueDockedBottom, setQueueDockedBottom] = useState(true);

  // Bulk action popover state
  const [bulkNote, setBulkNote] = useState("");
  const [bulkNoteOpen, setBulkNoteOpen] = useState(false);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [playlistOpen, setPlaylistOpen] = useState(false);
  const [metadataSyncing, setMetadataSyncing] = useState(false);

  const [searchParams] = useSearchParams();
  const { search, setSearch } = useSearch();
  const [activeChannel, setActiveChannel] = useState<string | null>(
    searchParams.get("channel")
  );
  const [activeTag, setActiveTag] = useState<string | null>(
    searchParams.get("tag")
  );
  const [sortState, setSortState] = useState<LibrarySortState>(() => {
    const saved = loadLibrarySort(loadSettings().defaultLibrarySort);
    if (saved.sort === "random" && !saved.randomSeed) {
      saved.randomSeed = Date.now();
    }
    return saved;
  });
  const { sort, order, randomSeed } = sortState;
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [channelTab, setChannelTab] = useState<"library" | "feed">("library");
  const [feedSearch, setFeedSearch] = useState("");
  const [feedSort, setFeedSort] = useState<"recent" | "popular">("recent");
  const [feedOrder, setFeedOrder] = useState<"asc" | "desc">("desc");
  const [feedLayout, setFeedLayoutState] = useState(loadFeedLayout);

  const setFeedLayout = useCallback((layout: "grid" | "list") => {
    setFeedLayoutState(layout);
    try {
      localStorage.setItem(FEED_LAYOUT_KEY, layout);
    } catch {
      // ignore storage errors
    }
  }, []);

  const [settings, update] = useSettings();
  const { showToast } = useToast();
  const { dismiss, dismissAll, isDismissed } = useContinueWatchingDismiss();
  const { onJobCompleted } = useDownloads();
  const { queue } = usePlayback();

  useEffect(() => {
    return onJobCompleted(() => setRefreshKey((k) => k + 1));
  }, [onJobCompleted]);

  const reloadChannels = () =>
    api
      .listChannels({ sort: settings.channelSort, order: settings.channelOrder })
      .then(setChannels)
      .catch(() => undefined);

  const submitRename = async (oldName: string) => {
    const next = renameValue.trim();
    setRenaming(null);
    if (!next || next === oldName) return;
    await api.renameChannel(oldName, next).catch(() => undefined);
    if (activeChannel === oldName) setActiveChannel(next);
    reloadChannels();
  };

  useEffect(() => {
    setActiveTag(searchParams.get("tag"));
    setActiveChannel(searchParams.get("channel"));
  }, [searchParams]);

  useEffect(() => {
    setChannelTab("library");
    setFeedSearch("");
    setFeedSort("recent");
    setFeedOrder("desc");
  }, [activeChannel]);

  const [debouncedSearch, setDebouncedSearch] = useState("");
  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(id);
  }, [search]);

  useEffect(() => {
    reloadChannels();
  }, [videos.length, settings.channelSort, settings.channelOrder]);

  useEffect(() => {
    api
      .listVideos({ continue_watching: true })
      .then(setContinueWatching)
      .catch(() => undefined);
  }, [videos.length, refreshKey]);

  useEffect(() => {
    api
      .tagStats(activeChannel || undefined)
      .then(setTags)
      .catch(() => undefined);
    setShowAllTags(false);
  }, [activeChannel, videos.length]);

  useEffect(() => {
    setLoading(true);
    api
      .listVideos({
        q: debouncedSearch || undefined,
        channel: activeChannel || undefined,
        tag: activeTag || undefined,
        sort,
        order,
        seed: sort === "random" ? randomSeed : undefined,
      })
      .then(setVideos)
      .catch(() => setVideos([]))
      .finally(() => setLoading(false));
  }, [
    debouncedSearch,
    activeChannel,
    activeTag,
    sort,
    order,
    randomSeed,
    refreshKey,
  ]);

  const visibleContinueWatching = useMemo(
    () => continueWatching.filter((v) => !isDismissed(v.id)),
    [continueWatching, isDismissed]
  );

  const visibleTags = useMemo(() => {
    const filtered = tags.filter(
      (t) => t.count > TAG_MIN_COUNT || t.tag === activeTag
    );
    if (!showAllTags && filtered.length > TAG_PAGE_SIZE) {
      return filtered.slice(0, TAG_PAGE_SIZE);
    }
    return filtered;
  }, [tags, activeTag, showAllTags]);

  const hiddenTagCount = useMemo(() => {
    const filtered = tags.filter(
      (t) => t.count > TAG_MIN_COUNT || t.tag === activeTag
    );
    return showAllTags ? 0 : Math.max(0, filtered.length - TAG_PAGE_SIZE);
  }, [tags, activeTag, showAllTags]);

  const headline = useMemo(() => {
    if (activeChannel) return activeChannel;
    if (activeTag) return `#${activeTag}`;
    return "Library";
  }, [activeChannel, activeTag]);

  const isHome = !activeChannel && !activeTag;

  const activeChannelUrl = useMemo(() => {
    if (!activeChannel) return null;
    return channels.find((c) => c.channel === activeChannel)?.channel_url ?? null;
  }, [activeChannel, channels]);

  const onFeedTab = Boolean(activeChannel) && channelTab === "feed";

  const showContinueRow =
    settings.showContinueWatching &&
    !activeChannel &&
    !activeTag &&
    !debouncedSearch &&
    visibleContinueWatching.length > 0;

  const handleSortChange = (value: string) => {
    const nextSort = value as LibrarySort;
    const next: LibrarySortState = {
      sort: nextSort,
      order: nextSort === "file_size" ? "desc" : order,
      randomSeed: nextSort === "random" ? Date.now() : undefined,
    };
    setSortState(next);
    saveLibrarySort(next);
  };

  const toggleOrder = () => {
    if (sort === "random") {
      const next: LibrarySortState = {
        sort,
        order,
        randomSeed: Date.now(),
      };
      setSortState(next);
      saveLibrarySort(next);
      return;
    }
    const next: LibrarySortState = {
      sort,
      order: order === "desc" ? "asc" : "desc",
    };
    setSortState(next);
    saveLibrarySort(next);
  };

  const formatSubscriberCount = (count: number | null) => {
    if (count === null) return null;
    if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
    if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
    return String(count);
  };

  const toggleSelect = (id: number, index: number, shiftHeld: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (shiftHeld && lastSelectedIndex.current !== null) {
        const lo = Math.min(index, lastSelectedIndex.current);
        const hi = Math.max(index, lastSelectedIndex.current);
        for (let i = lo; i <= hi; i++) {
          next.add(videos[i].id);
        }
      } else {
        if (next.has(id)) {
          next.delete(id);
        } else {
          next.add(id);
        }
      }
      return next;
    });
    lastSelectedIndex.current = index;
  };

  const exitSelectMode = () => {
    setSelectMode(false);
    setSelectedIds(new Set());
    lastSelectedIndex.current = null;
  };

  const bulkDelete = async () => {
    if (!selectedIds.size) return;
    if (!confirm(`Delete ${selectedIds.size} video(s) from your library? Files will not be removed.`)) return;
    await api.bulkDeleteVideos([...selectedIds]).catch(() => undefined);
    exitSelectMode();
    setRefreshKey((k) => k + 1);
  };

  const bulkSaveNote = async () => {
    if (!selectedIds.size || !bulkNote.trim()) return;
    await api.bulkUpdateNotes([...selectedIds], bulkNote.trim()).catch(() => undefined);
    setBulkNote("");
    setBulkNoteOpen(false);
    exitSelectMode();
  };

  const bulkAddToPlaylist = async (playlistId: number) => {
    if (!selectedIds.size) return;
    await api.bulkAddToPlaylist(playlistId, [...selectedIds]).catch(() => undefined);
    setPlaylistOpen(false);
    exitSelectMode();
  };

  const bulkDownload = () => {
    const selected = videos.filter((v) => selectedIds.has(v.id));
    selected.forEach((v, i) => {
      setTimeout(() => {
        const a = document.createElement("a");
        a.href = downloadFileUrl(v.id);
        a.download = v.title;
        a.click();
      }, i * 300);
    });
    exitSelectMode();
  };

  const bulkRefreshMetadata = async () => {
    if (!selectedIds.size || metadataSyncing) return;
    setMetadataSyncing(true);
    const result = await api
      .refreshMetadataBulk([...selectedIds])
      .catch(() => null);
    setMetadataSyncing(false);
    if (!result) {
      showToast("Metadata sync failed");
      return;
    }
    showToast(
      `Synced ${result.refreshed} video${result.refreshed === 1 ? "" : "s"}` +
        (result.failed ? ` (${result.failed} failed)` : "")
    );
    setRefreshKey((k) => k + 1);
    exitSelectMode();
  };

  const openPlaylistPicker = () => {
    api.listPlaylists().then(setPlaylists).catch(() => undefined);
    setPlaylistOpen(true);
  };

  const showQueuePanel = queue.length > 0 && !selectMode;

  const updateQueuePlacement = useCallback(() => {
    if (window.innerWidth < 1024) {
      setQueueDockedBottom(true);
      return;
    }
    const el = mainContentRef.current;
    if (!el) return;
    setQueueDockedBottom(
      el.getBoundingClientRect().right > window.innerWidth - QUEUE_RESERVE_PX
    );
  }, []);

  useLayoutEffect(() => {
    if (!showQueuePanel) return;
    updateQueuePlacement();
    const el = mainContentRef.current;
    const ro = new ResizeObserver(updateQueuePlacement);
    if (el) ro.observe(el);
    window.addEventListener("resize", updateQueuePlacement);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", updateQueuePlacement);
    };
  }, [
    showQueuePanel,
    updateQueuePlacement,
    settings.sidebarCollapsed,
    videos.length,
    showContinueRow,
    loading,
  ]);

  return (
    <div className={`flex gap-6${showQueuePanel && queueDockedBottom ? " pb-4" : ""}`}>
      {showQueuePanel && !queueDockedBottom && (
        <div className="pointer-events-none fixed inset-y-0 right-0 z-40 hidden w-[26rem] p-3 pt-20 lg:block">
          <div className="pointer-events-auto ml-auto flex max-h-full w-96 flex-col overflow-hidden">
            <PlaybackQueue className="max-h-[calc(100vh-6rem)] overflow-y-auto shadow-2xl" />
          </div>
        </div>
      )}
      {!settings.sidebarCollapsed && (
        <aside className="hidden w-56 shrink-0 lg:block">
          <div className="sticky top-20 space-y-6">
            <div>
              <div className="mb-2 flex items-center justify-between px-2">
                <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                  Channels
                </h2>
                <button
                  onClick={() => update({ sidebarCollapsed: true })}
                  title="Collapse sidebar"
                  className="rounded p-1 text-gray-500 hover:bg-ink-800 hover:text-accent"
                >
                  ‹
                </button>
              </div>
              <ul className="space-y-0.5">
              <li>
                <button
                  onClick={() => setActiveChannel(null)}
                  className={`w-full rounded-lg px-3 py-1.5 text-left text-sm ${
                    !activeChannel
                      ? "bg-accent/15 text-accent"
                      : "text-gray-300 hover:bg-ink-800"
                  }`}
                >
                  All channels
                </button>
              </li>
              {channels.map((c) => (
                <li key={c.channel}>
                  <button
                    onClick={() => setActiveChannel(c.channel)}
                    className={`group flex w-full min-w-0 items-center justify-between rounded-lg px-3 py-1.5 text-left text-sm ${
                      activeChannel === c.channel
                        ? "bg-accent/15 text-accent"
                        : "text-gray-300 hover:bg-ink-800"
                    }`}
                  >
                    <span className="truncate">{c.channel}</span>
                    <span className="ml-2 shrink-0 text-xs text-gray-500">
                      {settings.channelSort === "subscriber_count" &&
                      c.subscriber_count !== null
                        ? formatSubscriberCount(c.subscriber_count)
                        : c.count}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </aside>
      )}

      {settings.sidebarCollapsed && (
        <button
          onClick={() => update({ sidebarCollapsed: false })}
          title="Expand channels"
          className="sticky top-20 hidden h-fit rounded-lg border border-ink-700 bg-ink-900 px-2 py-3 text-sm text-gray-400 hover:border-accent hover:text-accent lg:block"
        >
          ›
        </button>
      )}

      <div ref={mainContentRef} className="min-w-0 flex-1">
        <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center">
          {activeChannel && renaming === activeChannel ? (
            <input
              autoFocus
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onBlur={() => submitRename(activeChannel)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitRename(activeChannel);
                if (e.key === "Escape") setRenaming(null);
              }}
              className="rounded-lg border border-accent bg-ink-950 px-3 py-1 text-2xl font-bold text-gray-100 outline-none"
            />
          ) : (
            <h1
              className={`group ${isHome ? "hidden md:flex" : "flex"} items-center gap-2 text-2xl font-bold text-gray-100`}
            >
              {headline}
              {activeChannel && (
                <button
                  onClick={() => {
                    setRenameValue(activeChannel);
                    setRenaming(activeChannel);
                  }}
                  title="Rename channel"
                  className="text-base text-gray-500 opacity-0 transition-opacity hover:text-accent group-hover:opacity-100"
                >
                  ✎
                </button>
              )}
            </h1>
          )}
          {activeChannel && !activeTag && (
            <div className="flex gap-1 rounded-lg border border-ink-700 bg-ink-900 p-1 sm:order-first">
              <button
                type="button"
                onClick={() => setChannelTab("library")}
                className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                  channelTab === "library"
                    ? "bg-accent/15 text-accent"
                    : "text-gray-400 hover:text-gray-200"
                }`}
              >
                Library
              </button>
              <button
                type="button"
                onClick={() => setChannelTab("feed")}
                className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                  channelTab === "feed"
                    ? "bg-accent/15 text-accent"
                    : "text-gray-400 hover:text-gray-200"
                }`}
              >
                Channel feed
              </button>
            </div>
          )}
          <div className="flex flex-1 flex-col gap-2 sm:flex-row sm:justify-end">
            {onFeedTab ? (
              <>
                <input
                  value={feedSearch}
                  onChange={(e) => setFeedSearch(e.target.value)}
                  placeholder="Search channel videos..."
                  className="hidden w-full rounded-lg border border-ink-700 bg-ink-900 px-4 py-2 text-sm text-gray-100 placeholder-gray-500 outline-none focus:border-accent md:block sm:w-64"
                />
                <div className="flex flex-row items-center gap-2">
                  <select
                    value={feedSort}
                    onChange={(e) =>
                      setFeedSort(e.target.value as "recent" | "popular")
                    }
                    className="min-w-[6.5rem] shrink-0 rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-gray-100 outline-none focus:border-accent"
                  >
                    <option value="recent">Recent</option>
                    <option value="popular">Popular</option>
                  </select>
                  <button
                    type="button"
                    onClick={() =>
                      setFeedOrder((o) => (o === "desc" ? "asc" : "desc"))
                    }
                    className="shrink-0 rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-gray-100 hover:border-accent"
                    title="Toggle sort direction"
                  >
                    {feedOrder === "desc" ? "↓" : "↑"}
                  </button>
                  <div className="flex shrink-0 rounded-lg border border-ink-700 bg-ink-900 p-0.5">
                    <button
                      type="button"
                      onClick={() => setFeedLayout("grid")}
                      title="Grid view"
                      className={`rounded-md px-2.5 py-1.5 transition-colors ${
                        feedLayout === "grid"
                          ? "bg-accent/15 text-accent"
                          : "text-gray-400 hover:text-gray-200"
                      }`}
                    >
                      <svg
                        viewBox="0 0 16 16"
                        className="h-4 w-4"
                        fill="currentColor"
                        aria-hidden
                      >
                        <rect x="1" y="1" width="6" height="6" rx="1" />
                        <rect x="9" y="1" width="6" height="6" rx="1" />
                        <rect x="1" y="9" width="6" height="6" rx="1" />
                        <rect x="9" y="9" width="6" height="6" rx="1" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      onClick={() => setFeedLayout("list")}
                      title="List view"
                      className={`rounded-md px-2.5 py-1.5 transition-colors ${
                        feedLayout === "list"
                          ? "bg-accent/15 text-accent"
                          : "text-gray-400 hover:text-gray-200"
                      }`}
                    >
                      <svg
                        viewBox="0 0 16 16"
                        className="h-4 w-4"
                        fill="currentColor"
                        aria-hidden
                      >
                        <rect x="1" y="2" width="14" height="2.5" rx="0.5" />
                        <rect x="1" y="6.75" width="14" height="2.5" rx="0.5" />
                        <rect x="1" y="11.5" width="14" height="2.5" rx="0.5" />
                      </svg>
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search videos..."
              className="hidden w-full rounded-lg border border-ink-700 bg-ink-900 px-4 py-2 text-sm text-gray-100 placeholder-gray-500 outline-none focus:border-accent md:block sm:w-64"
            />
            <div className="flex flex-row items-center gap-2">
              <select
                value={sort}
                onChange={(e) => handleSortChange(e.target.value)}
                className="min-w-[12.5rem] shrink-0 rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-gray-100 outline-none focus:border-accent"
              >
                {LIBRARY_SORT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              <button
                onClick={toggleOrder}
                className="shrink-0 rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-gray-100 hover:border-accent"
                title={
                  sort === "random" ? "Shuffle again" : "Toggle sort direction"
                }
              >
                {sort === "random" ? "⟳" : order === "desc" ? "↓" : "↑"}
              </button>
              {tags.some((t) => t.count > TAG_MIN_COUNT || t.tag === activeTag) && (
                <button
                  onClick={() => setShowTags((s) => !s)}
                  className="shrink-0 rounded-lg border border-ink-700 bg-ink-900 px-2 py-2 text-xs text-gray-300 hover:border-accent hover:text-accent md:hidden"
                >
                  {showTags ? "Hide tags" : "Tags"}
                </button>
              )}
              <button
                onClick={() => (selectMode ? exitSelectMode() : setSelectMode(true))}
                className={`shrink-0 rounded-lg border px-3 py-2 text-sm transition-colors ${
                  selectMode
                    ? "border-accent bg-accent/10 text-accent"
                    : "border-ink-700 bg-ink-900 text-gray-300 hover:border-accent hover:text-accent"
                }`}
              >
                {selectMode ? "Cancel" : "Select"}
              </button>
            </div>
              </>
            )}
          </div>
        </div>

        <div className="mb-5 flex flex-wrap items-center gap-2">
          {activeTag && (
            <button
              onClick={() => setActiveTag(null)}
              className="rounded-full bg-accent px-3 py-1 text-xs font-medium text-ink-950"
            >
              #{activeTag} ✕
            </button>
          )}
          {tags.some((t) => t.count > TAG_MIN_COUNT || t.tag === activeTag) && (
            <button
              onClick={() => setShowTags((s) => !s)}
              className="hidden rounded-full border border-ink-700 bg-ink-900 px-3 py-1 text-xs text-gray-300 hover:border-accent hover:text-accent md:inline-block"
            >
              {showTags ? "Hide tags" : "Show tags"}
            </button>
          )}
        </div>

        {showTags && visibleTags.length > 0 && (
          <div className="mb-5 flex flex-wrap gap-2">
            {visibleTags
              .filter((t) => t.tag !== activeTag)
              .map((t) => (
                <button
                  key={t.tag}
                  onClick={() => setActiveTag(t.tag)}
                  className="rounded-full border border-ink-700 bg-ink-900 px-3 py-1 text-xs text-gray-300 hover:border-accent hover:text-accent"
                >
                  #{t.tag}
                  <span className="ml-1.5 text-gray-500">{t.count}</span>
                </button>
              ))}
            {hiddenTagCount > 0 && (
              <button
                onClick={() => setShowAllTags(true)}
                className="rounded-full border border-ink-700 bg-ink-900 px-3 py-1 text-xs text-gray-400 hover:border-accent hover:text-accent"
              >
                Show more ({hiddenTagCount})
              </button>
            )}
          </div>
        )}

        {onFeedTab && feedSort === "popular" && (
          <p className="mb-4 text-xs text-gray-600">
            Popularity is based on loaded videos, not full channel history
            (YouTube limitation).
          </p>
        )}

        {showContinueRow && !onFeedTab && (
          <ContinueWatchingRow
            videos={visibleContinueWatching}
            showProgress={settings.showProgressOnContinueWatching}
            onDismiss={dismiss}
            onDismissAll={dismissAll}
          />
        )}

        {onFeedTab ? (
          <ChannelFeed
            channel={activeChannel!}
            channelUrl={activeChannelUrl}
            channels={channels}
            feedSearch={feedSearch}
            feedSort={feedSort}
            feedOrder={feedOrder}
            feedLayout={feedLayout}
          />
        ) : loading ? (
          <p className="py-20 text-center text-gray-500">Loading...</p>
        ) : videos.length === 0 ? (
          <div className="py-20 text-center text-gray-500">
            <p className="text-lg">No videos yet.</p>
            <p className="mt-1 text-sm">
              Paste a link on the Download page or drop files into your media
              folder.
            </p>
          </div>
        ) : (
          <div
            className={`grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 ${
              settings.sidebarCollapsed ? "xl:grid-cols-5" : "xl:grid-cols-4"
            }`}
          >
            {videos.map((v, idx) => (
              <VideoCard
                key={v.id}
                video={v}
                showViewCount={sort === "view_count"}
                progress={settings.showProgressOnAllVideos ? videoProgress(v) : undefined}
                selectable={selectMode}
                selected={selectedIds.has(v.id)}
                onSelect={(id, e) => toggleSelect(id, idx, e.shiftKey)}
              />
            ))}
          </div>
        )}

        {selectMode && selectedIds.size > 0 && (
            <div className="fixed inset-x-0 bottom-0 z-40 border-t border-ink-700 bg-ink-900/95 px-4 py-3 backdrop-blur">
              <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-3">
                <span className="text-sm font-medium text-gray-300">
                  {selectedIds.size} selected
                </span>

                {/* Add to playlist */}
                <div className="relative">
                  <button
                    onClick={() =>
                      playlistOpen ? setPlaylistOpen(false) : openPlaylistPicker()
                    }
                    className="rounded-lg bg-ink-800 px-3 py-1.5 text-sm text-gray-200 hover:bg-ink-700"
                  >
                    + Playlist
                  </button>
                  {playlistOpen && (
                    <div className="absolute bottom-10 left-0 z-50 w-56 rounded-lg bg-ink-800 p-2 shadow-xl ring-1 ring-ink-600">
                      {playlists.length === 0 ? (
                        <p className="px-2 py-1 text-xs text-gray-500">No playlists yet.</p>
                      ) : (
                        playlists.map((p) => (
                          <button
                            key={p.id}
                            onClick={() => bulkAddToPlaylist(p.id)}
                            className="block w-full truncate rounded px-2 py-1.5 text-left text-sm text-gray-200 hover:bg-ink-700"
                          >
                            {p.name}
                          </button>
                        ))
                      )}
                    </div>
                  )}
                </div>

                {/* Add note */}
                <div className="relative">
                  <button
                    onClick={() => setBulkNoteOpen((v) => !v)}
                    className="rounded-lg bg-ink-800 px-3 py-1.5 text-sm text-gray-200 hover:bg-ink-700"
                  >
                    Add note
                  </button>
                  {bulkNoteOpen && (
                    <div className="absolute bottom-10 left-0 z-50 w-72 rounded-lg bg-ink-800 p-3 shadow-xl ring-1 ring-ink-600">
                      <textarea
                        value={bulkNote}
                        onChange={(e) => setBulkNote(e.target.value)}
                        rows={3}
                        placeholder="Note to apply to all selected..."
                        className="w-full rounded-lg border border-ink-700 bg-ink-950 px-3 py-2 text-sm text-gray-100 outline-none focus:border-accent"
                        autoFocus
                      />
                      <button
                        onClick={bulkSaveNote}
                        disabled={!bulkNote.trim()}
                        className="mt-2 w-full rounded-lg bg-accent py-1.5 text-sm font-medium text-ink-950 hover:bg-accent-soft disabled:opacity-40"
                      >
                        Apply to {selectedIds.size} video{selectedIds.size === 1 ? "" : "s"}
                      </button>
                    </div>
                  )}
                </div>

                {/* Resync metadata */}
                <button
                  onClick={bulkRefreshMetadata}
                  disabled={metadataSyncing}
                  className="rounded-lg bg-ink-800 px-3 py-1.5 text-sm text-gray-200 hover:bg-ink-700 disabled:opacity-50"
                >
                  {metadataSyncing ? "Syncing…" : "Resync metadata"}
                </button>

                {/* Download to device */}
                <button
                  onClick={bulkDownload}
                  className="rounded-lg bg-ink-800 px-3 py-1.5 text-sm text-gray-200 hover:bg-ink-700"
                >
                  Download
                </button>

                {/* Delete */}
                <button
                  onClick={bulkDelete}
                  className="rounded-lg border border-red-500/40 px-3 py-1.5 text-sm text-red-400 hover:bg-red-500/10"
                >
                  Delete
                </button>

                <button
                  onClick={exitSelectMode}
                  className="ml-auto text-xs text-gray-500 hover:text-accent"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
      </div>

      {showQueuePanel && queueDockedBottom && (
        <div className="pointer-events-none fixed bottom-0 right-0 z-30 w-[26rem] p-3">
          <div className="pointer-events-auto ml-auto w-96">
            <PlaybackQueue
              collapsible
              listMaxHeightClass="max-h-[20vh] lg:max-h-[30vh]"
              className="shadow-2xl"
            />
          </div>
        </div>
      )}
    </div>
  );
}
