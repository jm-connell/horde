import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../api";
import ContinueWatchingRow from "../components/ContinueWatchingRow";
import VideoCard from "../components/VideoCard";
import { useDownloads } from "../context/DownloadContext";
import { useContinueWatchingDismiss } from "../hooks/useContinueWatchingDismiss";
import {
  LIBRARY_SORT_OPTIONS,
  loadLibrarySort,
  saveLibrarySort,
  type LibrarySort,
  type LibrarySortState,
} from "../hooks/useLibrarySort";
import { loadSettings, useSettings } from "../hooks/useSettings";
import type { ChannelStat, TagStat, Video } from "../types";

const TAG_MIN_COUNT = 3;
const TAG_PAGE_SIZE = 20;

export default function Library() {
  const [videos, setVideos] = useState<Video[]>([]);
  const [continueWatching, setContinueWatching] = useState<Video[]>([]);
  const [channels, setChannels] = useState<ChannelStat[]>([]);
  const [tags, setTags] = useState<TagStat[]>([]);
  const [showTags, setShowTags] = useState(false);
  const [showAllTags, setShowAllTags] = useState(false);
  const [loading, setLoading] = useState(true);

  const [searchParams] = useSearchParams();
  const [search, setSearch] = useState("");
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

  const [settings] = useSettings();
  const { dismiss, dismissAll, isDismissed } = useContinueWatchingDismiss();
  const { onJobCompleted } = useDownloads();

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

  return (
    <div className="flex gap-6">
      <aside className="hidden w-56 shrink-0 lg:block">
        <div className="sticky top-20 space-y-6">
          <div>
            <h2 className="mb-2 px-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
              Channels
            </h2>
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

      <div className="min-w-0 flex-1">
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
            <h1 className="group flex items-center gap-2 text-2xl font-bold text-gray-100">
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
          <div className="flex flex-1 flex-col gap-2 sm:flex-row sm:justify-end">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search videos..."
              className="w-full rounded-lg border border-ink-700 bg-ink-900 px-4 py-2 text-sm text-gray-100 placeholder-gray-500 outline-none focus:border-accent sm:w-64"
            />
            <select
              value={sort}
              onChange={(e) => handleSortChange(e.target.value)}
              className="rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-gray-100 outline-none focus:border-accent"
            >
              {LIBRARY_SORT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <button
              onClick={toggleOrder}
              className="rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-gray-100 hover:border-accent"
              title={
                sort === "random" ? "Shuffle again" : "Toggle sort direction"
              }
            >
              {sort === "random" ? "⟳" : order === "desc" ? "↓" : "↑"}
            </button>
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
              className="rounded-full border border-ink-700 bg-ink-900 px-3 py-1 text-xs text-gray-300 hover:border-accent hover:text-accent"
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

        {showContinueRow && (
          <ContinueWatchingRow
            videos={visibleContinueWatching}
            onDismiss={dismiss}
            onDismissAll={dismissAll}
          />
        )}

        {loading ? (
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
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
            {videos.map((v) => (
              <VideoCard
                key={v.id}
                video={v}
                showViewCount={sort === "view_count"}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
