import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, downloadFileUrl } from "../api";
import ContinueWatchingRow from "../components/ContinueWatchingRow";
import ChannelFeed from "../components/ChannelFeed";
import ChannelFeedCard from "../components/ChannelFeedCard";
import ChannelSidebar from "../components/ChannelSidebar";
import HelpTip from "../components/HelpTip";
import LibraryBulkBar from "../components/LibraryBulkBar";
import LiquidNav from "../components/LiquidNav";
import LoadingIndicator from "../components/LoadingIndicator";
import PlaybackQueue from "../components/PlaybackQueue";
import RecommendedHome from "../components/RecommendedHome";
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
import type {
  ChannelFeedEntry,
  ChannelStat,
  Playlist,
  TagStat,
  Video,
} from "../types";
import {
  queueDockAlignClass,
  queueDockStyle,
} from "../utils/miniPlayerLayout";
import { Toggle } from "./settings/ui";
import {
  FEED_INDEX_TIP,
  FEED_SEARCH_TIP,
  formatCatalogProgress,
  type CatalogProgress,
} from "./libraryCatalogProgress";
import {
  loadChannelUrlMap,
  loadFeedLayout,
  loadHomeTab,
  saveChannelUrl,
  saveFeedLayout,
  saveHomeTab,
  type HomeTab,
} from "./libraryStorage";

const TAG_MIN_COUNT = 3;


const TAG_PAGE_SIZE = 20;
// Fixed queue overlay width (w-[26rem]) — dock to bottom when grid extends into this zone.
const QUEUE_RESERVE_PX = 416;

function videoProgress(video: Video): number | undefined {
  if (!video.duration_sec || video.duration_sec <= 0) return undefined;
  if (video.last_position_sec <= 0) return undefined;
  return Math.min(1, video.last_position_sec / video.duration_sec);
}

export default function Library() {
  const [videos, setVideos] = useState<Video[]>([]);
  const [otherVideos, setOtherVideos] = useState<Video[]>([]);
  const [streamResults, setStreamResults] = useState<ChannelFeedEntry[]>([]);
  const [streamDownloading, setStreamDownloading] = useState<Set<string>>(
    () => new Set()
  );
  const [continueWatching, setContinueWatching] = useState<Video[]>([]);
  const [channels, setChannels] = useState<ChannelStat[]>([]);
  const [tags, setTags] = useState<TagStat[]>([]);
  const [showTags, setShowTags] = useState(false);
  const [showAllTags, setShowAllTags] = useState(false);
  const [showAllChannels, setShowAllChannels] = useState(false);
  const [loading, setLoading] = useState(true);

  // Multi-select state
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const lastSelectedIndex = useRef<number | null>(null);
  const mainContentRef = useRef<HTMLDivElement>(null);
  const headerRowRef = useRef<HTMLDivElement>(null);
  const [headerTagsFit, setHeaderTagsFit] = useState(true);
  const [queueDockedBottom, setQueueDockedBottom] = useState(true);

  // Bulk action popover state
  const [bulkNote, setBulkNote] = useState("");
  const [bulkNoteOpen, setBulkNoteOpen] = useState(false);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [playlistOpen, setPlaylistOpen] = useState(false);
  const [metadataSyncing, setMetadataSyncing] = useState(false);

  const [searchParams, setSearchParams] = useSearchParams();
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
  const [channelUrlOverrides, setChannelUrlOverrides] = useState<
    Record<string, string>
  >(loadChannelUrlMap);
  const [homeTab, setHomeTabState] = useState<HomeTab>(loadHomeTab);
  const [aiReady, setAiReady] = useState(false);
  const [feedSearch, setFeedSearch] = useState("");
  const [feedSort, setFeedSort] = useState<"recent" | "popular">("recent");
  const [feedOrder, setFeedOrder] = useState<"asc" | "desc">("desc");
  const [feedLayout, setFeedLayoutState] = useState(loadFeedLayout);

  const setHomeTab = useCallback((tab: HomeTab) => {
    setHomeTabState(tab);
    saveHomeTab(tab);
  }, []);

  const setFeedLayout = useCallback((layout: "grid" | "list") => {
    setFeedLayoutState(layout);
    saveFeedLayout(layout);
  }, []);

  const [settings, update] = useSettings();
  const { showToast } = useToast();
  const { dismiss, dismissAll, isDismissed } = useContinueWatchingDismiss();
  const { onJobCompleted, submitDownload } = useDownloads();
  const { queue, miniPlayerActive, miniPlayerRect } = usePlayback();
  const [narrowViewport, setNarrowViewport] = useState(
    () => typeof window !== "undefined" && window.innerWidth < 1100
  );
  const [sidebarOverlayOpen, setSidebarOverlayOpen] = useState(false);
  const [sidebarOverlayVisible, setSidebarOverlayVisible] = useState(false);

  useEffect(() => {
    const onResize = () => {
      const narrow = window.innerWidth < 1100;
      setNarrowViewport(narrow);
      if (!narrow) {
        setSidebarOverlayOpen(false);
        setSidebarOverlayVisible(false);
      }
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // On narrow viewports, keep the rail collapsed; expand opens as overlay.
  useEffect(() => {
    if (narrowViewport && !settings.sidebarCollapsed && !sidebarOverlayOpen) {
      update({ sidebarCollapsed: true });
    }
  }, [narrowViewport]); // eslint-disable-line react-hooks/exhaustive-deps

  const openSidebar = () => {
    if (narrowViewport) {
      setSidebarOverlayVisible(true);
      // Next frame so the enter transition runs from the closed state.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => setSidebarOverlayOpen(true));
      });
    } else {
      update({ sidebarCollapsed: false });
    }
  };

  const closeSidebar = () => {
    setSidebarOverlayOpen(false);
    update({ sidebarCollapsed: true });
  };

  // Unmount overlay after exit transition completes.
  useEffect(() => {
    if (sidebarOverlayOpen) {
      setSidebarOverlayVisible(true);
      return;
    }
    if (!sidebarOverlayVisible) return;
    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      setSidebarOverlayVisible(false);
      return;
    }
    const t = window.setTimeout(() => setSidebarOverlayVisible(false), 320);
    return () => window.clearTimeout(t);
  }, [sidebarOverlayOpen, sidebarOverlayVisible]);

  useEffect(() => {
    if (!narrowViewport) {
      setSidebarOverlayOpen(false);
      setSidebarOverlayVisible(false);
    }
  }, [narrowViewport]);

  useEffect(() => {
    return onJobCompleted(() => setRefreshKey((k) => k + 1));
  }, [onJobCompleted]);

  useEffect(() => {
    let active = true;
    const poll = () =>
      api
        .getAiStatus()
        .then((s) => {
          if (active) setAiReady(Boolean(s.ready && s.enabled && !s.paused));
        })
        .catch(() => {
          if (active) setAiReady(false);
        });
    poll();
    const id = setInterval(poll, 15000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, []);

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
    if (searchParams.get("tab") === "feed" && searchParams.get("channel")) {
      update({ showUndownloadedOnChannel: true });
      const next = new URLSearchParams(searchParams);
      next.delete("tab");
      setSearchParams(next, { replace: true });
    }
  }, [searchParams]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
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
      .then(async (matches) => {
        setVideos(matches);
        if (!debouncedSearch) {
          setOtherVideos([]);
          return;
        }
        try {
          const all = await api.listVideos({
            channel: activeChannel || undefined,
            tag: activeTag || undefined,
            sort,
            order,
            seed: sort === "random" ? randomSeed : undefined,
          });
          const matchIds = new Set(matches.map((v) => v.id));
          setOtherVideos(all.filter((v) => !matchIds.has(v.id)));
        } catch {
          setOtherVideos([]);
        }
      })
      .catch(() => {
        setVideos([]);
        setOtherVideos([]);
      })
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

  // Global catalog search (home search only — channel pages use feed search).
  useEffect(() => {
    if (!debouncedSearch || activeChannel) {
      setStreamResults([]);
      return;
    }
    let cancelled = false;
    api
      .searchChannelCatalog({ q: debouncedSearch, limit: 40 })
      .then((page) => {
        if (!cancelled) setStreamResults(page.entries ?? []);
      })
      .catch(() => {
        if (!cancelled) setStreamResults([]);
      });
    return () => {
      cancelled = true;
    };
  }, [debouncedSearch, activeChannel, refreshKey]);

  const visibleContinueWatching = useMemo(
    () => continueWatching.filter((v) => !isDismissed(v.id)),
    [continueWatching, isDismissed]
  );

  const selectableVideos = useMemo(
    () => (debouncedSearch ? [...videos, ...otherVideos] : videos),
    [debouncedSearch, videos, otherVideos]
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
    return "Home";
  }, [activeChannel, activeTag]);

  const isHome = !activeChannel && !activeTag;
  const showHomeTabs = isHome && aiReady;
  const onRecommendedTab = showHomeTabs && homeTab === "recommended";

  // Hide the mid-width Tags control before it crowds the search / home tabs.
  useLayoutEffect(() => {
    const row = headerRowRef.current;
    if (!row || !isHome || onRecommendedTab) {
      setHeaderTagsFit(true);
      return;
    }

    const TAGS_SLOT = 88;
    const GAP = 12;
    // Keep search usable; drop Tags once it would crush the field.
    const SEARCH_COMFORT = 140;

    const measure = () => {
      const tagsBtn = row.querySelector(
        "[data-header-tags]"
      ) as HTMLElement | null;
      const filters = row.querySelector(
        "[data-header-filters]"
      ) as HTMLElement | null;
      const searchEl = row.querySelector(
        "[data-header-search]"
      ) as HTMLElement | null;
      if (!filters) {
        setHeaderTagsFit(true);
        return;
      }

      const searchShown =
        searchEl != null &&
        searchEl.offsetParent !== null &&
        getComputedStyle(searchEl).display !== "none";

      if (tagsBtn) {
        const searchTooNarrow =
          searchShown && searchEl.offsetWidth < SEARCH_COMFORT;
        const overflow = row.scrollWidth > row.clientWidth + 1;
        setHeaderTagsFit(!searchTooNarrow && !overflow);
        return;
      }

      // Tags hidden — restore when a Tags-sized slot fits without crushing search.
      let leftUsed = 0;
      for (const child of Array.from(row.children) as HTMLElement[]) {
        if (child === filters) continue;
        if (child.offsetParent === null || child.offsetHeight === 0) continue;
        leftUsed += child.offsetWidth + GAP;
      }

      let filterFixed = 0;
      let filterGaps = 0;
      for (const child of Array.from(filters.children) as HTMLElement[]) {
        if (child.hasAttribute("data-header-search")) continue;
        if (child.offsetParent === null || child.offsetHeight === 0) continue;
        filterFixed += child.offsetWidth;
        filterGaps += GAP;
      }

      const reserved =
        leftUsed + TAGS_SLOT + GAP + filterFixed + filterGaps;
      if (!searchShown) {
        setHeaderTagsFit(reserved <= row.clientWidth + 1);
        return;
      }

      const availableForSearch = row.clientWidth - reserved;
      setHeaderTagsFit(availableForSearch >= SEARCH_COMFORT);
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(row);
    return () => ro.disconnect();
  }, [
    isHome,
    onRecommendedTab,
    showHomeTabs,
    showTags,
    search,
    sort,
    order,
    selectMode,
    tags,
    headerTagsFit,
  ]);

  const activeChannelUrl = useMemo(() => {
    if (!activeChannel) return null;
    return (
      channels.find((c) => c.channel === activeChannel)?.channel_url ??
      channelUrlOverrides[activeChannel] ??
      null
    );
  }, [activeChannel, channels, channelUrlOverrides]);

  const onChannelPage = Boolean(activeChannel);
  const [indexingChannel, setIndexingChannel] = useState(false);
  const [catalogProgress, setCatalogProgress] = useState<CatalogProgress | null>(
    null
  );

  useEffect(() => {
    if (!onChannelPage || !activeChannelUrl) {
      setCatalogProgress(null);
      return;
    }
    let cancelled = false;
    const load = () => {
      api
        .getChannelCatalogStatus()
        .then((status) => {
          if (cancelled) return;
          const norm = (u: string) =>
            u
              .replace(/\/+$/, "")
              .replace(
                /\/(videos|shorts|streams|playlists|featured|about)$/i,
                ""
              )
              .toLowerCase();
          const target = norm(activeChannelUrl);
          const hit =
            status.catalogs.find((c) => norm(c.channel_url) === target) ?? null;
          const isCurrentJob =
            status.running &&
            status.current_channel_url != null &&
            norm(status.current_channel_url) === target;
          const maxVideos = hit?.max_videos || 1000;
          if (!hit) {
            setCatalogProgress({
              indexed: isCurrentJob ? status.done : 0,
              total: null,
              maxVideos,
              complete: false,
              status: null,
              indexing: isCurrentJob,
            });
            return;
          }
          const indexing =
            hit.status === "queued" ||
            hit.status === "indexing" ||
            isCurrentJob;
          // While the flat list is still growing, prefer live done count.
          const indexed =
            isCurrentJob &&
            status.current_phase === "flat" &&
            status.done > 0
              ? status.done
              : hit.indexed_count;
          setCatalogProgress({
            indexed,
            total: hit.channel_total,
            maxVideos,
            complete: hit.complete && !indexing,
            status: hit.status,
            indexing,
          });
        })
        .catch(() => undefined);
    };
    load();
    const id = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [onChannelPage, activeChannelUrl]);

  const triggerChannelIndex = async () => {
    if (!activeChannel || indexingChannel) return;
    if (!activeChannelUrl) {
      showToast("No YouTube URL known for this channel yet");
      return;
    }
    setIndexingChannel(true);
    try {
      const result = await api.indexChannelCatalog({
        channel: activeChannel,
        url: activeChannelUrl,
        force: true,
      });
      showToast(result.detail || "Channel indexing queued");
      // Refresh progress immediately so the status line updates.
      api
        .getChannelCatalogStatus()
        .then((status) => {
          if (!activeChannelUrl) return;
          const norm = (u: string) =>
            u
              .replace(/\/+$/, "")
              .replace(
                /\/(videos|shorts|streams|playlists|featured|about)$/i,
                ""
              )
              .toLowerCase();
          const target = norm(activeChannelUrl);
          const hit = status.catalogs.find(
            (c) => norm(c.channel_url) === target
          );
          setCatalogProgress({
            indexed: hit?.indexed_count ?? 0,
            total: hit?.channel_total ?? null,
            maxVideos: hit?.max_videos || 1000,
            complete: false,
            status: hit?.status ?? "queued",
            indexing: true,
          });
        })
        .catch(() => undefined);
    } catch (err) {
      showToast(
        err instanceof Error && err.message
          ? err.message
          : "Could not start channel indexing"
      );
    } finally {
      setIndexingChannel(false);
    }
  };

  const showContinueRow =
    settings.showContinueWatching &&
    !activeChannel &&
    !activeTag &&
    !onRecommendedTab &&
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

  const selectChannel = (channel: string | null) => {
    setActiveChannel(channel);
    setActiveTag(null);
    setSearch("");
    if (narrowViewport) closeSidebar();
  };

  const selectRemoteChannel = (hit: {
    name: string;
    url: string;
    subscriber_count: number | null;
  }) => {
    saveChannelUrl(hit.name, hit.url);
    setChannelUrlOverrides((prev) => ({ ...prev, [hit.name]: hit.url }));
    setActiveChannel(hit.name);
    setActiveTag(null);
    setSearch("");
    update({ showUndownloadedOnChannel: true });
    if (narrowViewport) closeSidebar();
  };

  const toggleSelect = (id: number, index: number, shiftHeld: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (shiftHeld && lastSelectedIndex.current !== null) {
        const lo = Math.min(index, lastSelectedIndex.current);
        const hi = Math.max(index, lastSelectedIndex.current);
        for (let i = lo; i <= hi; i++) {
          next.add(selectableVideos[i].id);
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
    try {
      await api.bulkDeleteVideos([...selectedIds]);
      exitSelectMode();
      setRefreshKey((k) => k + 1);
    } catch {
      showToast("Could not delete selected videos");
    }
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
      {/* Narrow: fixed overlay channel panel — toggle stays on the sticky rail */}
      {narrowViewport && sidebarOverlayVisible && (
        <div className="fixed inset-0 z-50 hidden md:block">
          <button
            type="button"
            aria-label="Close channels"
            className={`absolute inset-0 bg-ink-950/60 backdrop-blur-sm transition-opacity duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${
              sidebarOverlayOpen ? "opacity-100" : "opacity-0"
            }`}
            onClick={closeSidebar}
          />
          <div
            className={`absolute top-0 flex h-full max-w-[85vw] flex-col p-3 pt-20 left-3 pl-12 md:left-6 md:pl-[3.25rem] transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${
              // Clear left-3 / md:left-6 so the panel fully exits the viewport.
              sidebarOverlayOpen
                ? "translate-x-0"
                : "-translate-x-[calc(100%+0.75rem)] md:-translate-x-[calc(100%+1.5rem)]"
            }`}
          >
            <div className="ui-panel ui-panel-legible flex max-h-full w-56 flex-col overflow-hidden rounded-xl bg-ink-900 p-2 ring-1 ring-ink-700">
              <div className="mb-2 flex shrink-0 items-center px-2 pt-1">
                <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                  Channels
                </h2>
              </div>
              <div className="min-h-0 overflow-y-auto">
                <ChannelSidebar
                  channels={channels}
                  activeChannel={activeChannel}
                  channelSort={settings.channelSort}
                  showAllChannels={showAllChannels}
                  onSelectChannel={selectChannel}
                  onSelectRemoteChannel={selectRemoteChannel}
                  onToggleShowAll={() => setShowAllChannels((v) => !v)}
                />
              </div>
            </div>
          </div>
        </div>
      )}

      <aside
        data-horde="sidebar"
        className={`relative hidden shrink-0 transition-[width] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] md:block ${
          narrowViewport || settings.sidebarCollapsed ? "w-10" : "w-56"
        }${narrowViewport && sidebarOverlayOpen ? " z-[60]" : ""}`}
      >
        <div className="sticky top-20">
          {!narrowViewport && !settings.sidebarCollapsed ? (
            <div className="ui-panel h-fit w-56 rounded-xl bg-ink-900 p-2 ring-1 ring-ink-700">
              <div className="mb-2 flex items-center gap-1 px-2 pt-1">
                <button
                  onClick={closeSidebar}
                  title="Collapse sidebar"
                  className="ui-interactive flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-base text-gray-500 hover:bg-ink-800 hover:text-accent"
                >
                  ‹
                </button>
                <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                  Channels
                </h2>
              </div>
              <ChannelSidebar
                channels={channels}
                activeChannel={activeChannel}
                channelSort={settings.channelSort}
                showAllChannels={showAllChannels}
                onSelectChannel={selectChannel}
                onSelectRemoteChannel={selectRemoteChannel}
                onToggleShowAll={() => setShowAllChannels((v) => !v)}
              />
            </div>
          ) : (
            <button
              onClick={
                narrowViewport && sidebarOverlayOpen
                  ? closeSidebar
                  : openSidebar
              }
              title={
                narrowViewport && sidebarOverlayOpen
                  ? "Collapse sidebar"
                  : "Expand channels"
              }
              className="ui-panel ui-interactive flex h-8 w-8 items-center justify-center rounded-md text-base text-gray-500 ring-1 ring-ink-700 hover:bg-ink-800 hover:text-accent"
            >
              {narrowViewport && sidebarOverlayOpen ? "‹" : "›"}
            </button>
          )}
        </div>
      </aside>

      <div ref={mainContentRef} className="min-w-0 flex-1">
        <div
          ref={headerRowRef}
          className={`mb-5 flex min-w-0 items-center gap-2 sm:gap-3 ${
            isHome ? "max-md:flex-wrap md:flex-nowrap" : "flex-wrap"
          }`}
        >
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
            <>
              <h1
                className={`group ${
                  isHome ? "hidden lg:flex" : "flex"
                } shrink-0 items-center gap-2 text-2xl font-bold text-gray-100`}
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
              {isHome &&
                !onRecommendedTab &&
                headerTagsFit &&
                tags.some(
                  (t) => t.count > TAG_MIN_COUNT || t.tag === activeTag
                ) && (
                  <button
                    type="button"
                    data-header-tags
                    onClick={() => setShowTags((s) => !s)}
                    className="ui-panel ui-interactive hidden shrink-0 rounded-lg border border-ink-700 bg-ink-900 px-2.5 py-1.5 text-sm text-gray-300 hover:border-accent hover:text-accent sm:inline-flex lg:hidden"
                  >
                    {showTags ? "Hide tags" : "Tags"}
                  </button>
                )}
            </>
          )}

          {showHomeTabs && (
            <LiquidNav
              className="ui-panel inline-flex shrink-0 rounded-xl bg-ink-900 p-1 ring-1 ring-ink-700"
              pillClassName="bg-ink-800"
              dependency={homeTab}
            >
              <button
                type="button"
                data-liquid-active={homeTab === "library" ? "true" : undefined}
                onClick={() => setHomeTab("library")}
                className={`ui-interactive relative z-10 rounded-lg px-2 py-1.5 text-sm font-medium transition-colors sm:px-3 ${
                  homeTab === "library"
                    ? settings.navIndicator !== "none"
                      ? "text-gray-100"
                      : "bg-ink-800 text-gray-100"
                    : "text-gray-400 hover:text-gray-200"
                } ${
                  settings.navIndicator === "none" && homeTab !== "library"
                    ? "hover:bg-ink-800/60"
                    : ""
                }`}
              >
                Library
              </button>
              <button
                type="button"
                data-liquid-active={
                  homeTab === "recommended" ? "true" : undefined
                }
                onClick={() => setHomeTab("recommended")}
                className={`ui-interactive relative z-10 rounded-lg px-2 py-1.5 text-sm font-medium transition-colors sm:px-3 ${
                  homeTab === "recommended"
                    ? settings.navIndicator !== "none"
                      ? "text-gray-100"
                      : "bg-ink-800 text-gray-100"
                    : "text-gray-400 hover:text-gray-200"
                } ${
                  settings.navIndicator === "none" && homeTab !== "recommended"
                    ? "hover:bg-ink-800/60"
                    : ""
                }`}
              >
                Recommended
              </button>
            </LiquidNav>
          )}
          {activeChannel && !activeTag && (
            <label className="inline-flex shrink-0 items-center gap-2 text-sm text-gray-300">
              <span className="hidden sm:inline">Show undownloaded</span>
              <span className="sm:hidden">Undownloaded</span>
              <Toggle
                checked={settings.showUndownloadedOnChannel}
                onChange={() =>
                  update({
                    showUndownloadedOnChannel:
                      !settings.showUndownloadedOnChannel,
                  })
                }
              />
            </label>
          )}

          <div
            data-header-filters
            className="ml-auto flex min-w-0 flex-1 flex-nowrap items-center justify-end gap-1.5 sm:gap-2"
          >
            {onChannelPage ? (
              <>
                <div className="flex min-w-0 flex-1 items-center gap-1.5 md:flex-initial md:w-auto">
                  <input
                    data-header-search
                    value={feedSearch}
                    onChange={(e) => setFeedSearch(e.target.value)}
                    placeholder="Search"
                    className="ui-panel ui-interactive min-w-0 max-w-64 flex-1 basis-24 rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-gray-100 placeholder-gray-500 outline-none focus:border-accent sm:px-4 md:basis-40"
                  />
                  <HelpTip text={FEED_SEARCH_TIP} placement="bottom" />
                </div>
                <button
                  type="button"
                  onClick={() => void triggerChannelIndex()}
                  disabled={indexingChannel || !activeChannelUrl}
                  className="ui-panel ui-interactive shrink-0 rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-gray-100 hover:border-accent disabled:cursor-not-allowed disabled:opacity-50"
                  title="Index this channel’s uploads for search"
                >
                  {indexingChannel ? "Queuing…" : "Index channel"}
                </button>
                <select
                  value={feedSort}
                  onChange={(e) =>
                    setFeedSort(e.target.value as "recent" | "popular")
                  }
                  className="min-w-[6.5rem] shrink-0 rounded-lg border border-ink-700 bg-ink-950 px-2 py-2 text-sm text-gray-100 outline-none focus:border-accent sm:px-3"
                >
                  <option value="recent">Recent</option>
                  <option value="popular">Popular</option>
                </select>
                <button
                  type="button"
                  onClick={() =>
                    setFeedOrder((o) => (o === "desc" ? "asc" : "desc"))
                  }
                  className="ui-panel ui-interactive shrink-0 rounded-lg border border-ink-700 bg-ink-900 px-2.5 py-2 text-sm text-gray-100 hover:border-accent sm:px-3"
                  title="Toggle sort direction"
                >
                  {feedOrder === "desc" ? "↓" : "↑"}
                </button>
                <div className="ui-panel flex shrink-0 rounded-lg border border-ink-700 bg-ink-900 p-0.5">
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
              </>
            ) : (
              <>
                <input
                  data-header-search
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search"
                  className="ui-panel ui-interactive hidden min-w-0 max-w-64 flex-1 basis-24 rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-gray-100 placeholder-gray-500 outline-none focus:border-accent sm:px-4 md:block md:basis-40"
                />
                <select
                  value={sort}
                  onChange={(e) => handleSortChange(e.target.value)}
                  className="w-[min(12.5rem,100%)] min-w-[9.5rem] shrink-0 rounded-lg border border-ink-700 bg-ink-950 px-2 py-2 text-sm text-gray-100 outline-none focus:border-accent sm:min-w-[12.5rem] sm:px-3"
                >
                  {LIBRARY_SORT_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
                <button
                  onClick={toggleOrder}
                  className="ui-panel ui-interactive shrink-0 rounded-lg border border-ink-700 bg-ink-900 px-2.5 py-2 text-sm text-gray-100 hover:border-accent sm:px-3"
                  title={
                    sort === "random" ? "Shuffle again" : "Toggle sort direction"
                  }
                >
                  {sort === "random" ? "⟳" : order === "desc" ? "↓" : "↑"}
                </button>
                {!isHome &&
                  !onRecommendedTab &&
                  tags.some(
                    (t) => t.count > TAG_MIN_COUNT || t.tag === activeTag
                  ) && (
                    <button
                      onClick={() => setShowTags((s) => !s)}
                      className="ui-panel ui-interactive shrink-0 rounded-lg border border-ink-700 bg-ink-900 px-2 py-2 text-xs text-gray-300 hover:border-accent hover:text-accent lg:hidden"
                    >
                      {showTags ? "Hide tags" : "Tags"}
                    </button>
                  )}
                {!onRecommendedTab && (
                  <button
                    onClick={() =>
                      selectMode ? exitSelectMode() : setSelectMode(true)
                    }
                    className={`ui-panel ui-interactive shrink-0 rounded-lg border px-2.5 py-2 text-sm transition-colors sm:px-3 ${
                      selectMode
                        ? "border-accent bg-accent/10 text-accent"
                        : "border-ink-700 bg-ink-900 text-gray-300 hover:border-accent hover:text-accent"
                    }`}
                  >
                    {selectMode ? "Cancel" : "Select"}
                  </button>
                )}
              </>
            )}
          </div>
        </div>

        {!onRecommendedTab && (
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
              className="ui-panel ui-interactive hidden rounded-lg border border-ink-700 bg-ink-900 px-3 py-1.5 text-xs text-gray-300 hover:border-accent hover:text-accent lg:inline-block"
            >
              {showTags ? "Hide tags" : "Show tags"}
            </button>
          )}
          {showTags &&
            visibleTags
              .filter((t) => t.tag !== activeTag)
              .map((t) => (
                <button
                  key={t.tag}
                  onClick={() => setActiveTag(t.tag)}
                  className="ui-panel ui-interactive rounded-full border border-ink-700 bg-ink-900 px-3 py-1 text-xs text-gray-300 hover:border-accent hover:text-accent"
                >
                  #{t.tag}
                  <span className="ml-1.5 text-gray-500">{t.count}</span>
                </button>
              ))}
          {showTags && hiddenTagCount > 0 && (
            <button
              onClick={() => setShowAllTags(true)}
              className="ui-panel ui-interactive rounded-full border border-ink-700 bg-ink-900 px-3 py-1 text-xs text-gray-400 hover:border-accent hover:text-accent"
            >
              Show more ({hiddenTagCount})
            </button>
          )}
          {onChannelPage && catalogProgress && (
            <span className="ml-auto inline-flex items-center gap-1.5 text-xs text-gray-500">
              {formatCatalogProgress(catalogProgress)}
              <HelpTip text={FEED_INDEX_TIP} placement="bottom" />
            </span>
          )}
        </div>
        )}

        {onChannelPage && feedSort === "popular" && (
          <p className="mb-4 text-xs text-gray-600">
            Popularity is based on loaded videos, not full channel history
            (YouTube limitation).
          </p>
        )}

        {showContinueRow && !onChannelPage && !onRecommendedTab && (
          <ContinueWatchingRow
            videos={visibleContinueWatching}
            showProgress={settings.showProgressOnContinueWatching}
            onDismiss={dismiss}
            onDismissAll={dismissAll}
          />
        )}

        <div
          key={
            onChannelPage ? "feed" : onRecommendedTab ? "recommended" : "library"
          }
          className="page-shell page-shell--animate"
        >
        {onChannelPage ? (
          <ChannelFeed
            channel={activeChannel!}
            channelUrl={activeChannelUrl}
            channels={channels}
            feedSearch={feedSearch}
            feedSort={feedSort}
            feedOrder={feedOrder}
            feedLayout={feedLayout}
            showUndownloaded={settings.showUndownloadedOnChannel}
            queueDockedBottom={showQueuePanel && queueDockedBottom}
          />
        ) : onRecommendedTab && !debouncedSearch ? (
          <RecommendedHome sidebarCollapsed={settings.sidebarCollapsed} />
        ) : loading ? (
          <LoadingIndicator />
        ) : videos.length === 0 &&
          otherVideos.length === 0 &&
          streamResults.length === 0 ? (
          <div className="py-20 text-center text-gray-500">
            <p className="text-lg">
              {debouncedSearch ? "No matching videos." : "No videos yet."}
            </p>
            {!debouncedSearch && (
              <p className="mt-1 text-sm">
                Paste a link on the Download page or drop files into your media
                folder.
              </p>
            )}
          </div>
        ) : (
          <div className="space-y-6">
            {debouncedSearch && videos.length > 0 && (
              <div className="flex items-center gap-3">
                <hr className="min-w-0 flex-1 border-0 border-t border-ink-700" />
                <span className="shrink-0 text-xs font-medium text-gray-400">
                  In your library
                  <span className="ml-1.5 text-gray-500">
                    ({videos.length})
                  </span>
                </span>
                <hr className="min-w-0 flex-1 border-0 border-t border-ink-700" />
              </div>
            )}
            {videos.length > 0 && (
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
            {debouncedSearch && streamResults.length > 0 && (
              <>
                <div className="flex items-center gap-3">
                  <hr className="min-w-0 flex-1 border-0 border-t border-ink-700" />
                  <span className="shrink-0 text-xs font-medium text-gray-400">
                    Available to stream
                    <span className="ml-1.5 text-gray-500">
                      ({streamResults.length})
                    </span>
                  </span>
                  <hr className="min-w-0 flex-1 border-0 border-t border-ink-700" />
                </div>
                <div
                  className={`grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 ${
                    settings.sidebarCollapsed
                      ? "xl:grid-cols-5"
                      : "xl:grid-cols-4"
                  }`}
                >
                  {streamResults.map((entry) => {
                    const channelName = entry.channel || "Unknown channel";
                    return (
                      <ChannelFeedCard
                        key={entry.id || entry.url}
                        entry={entry}
                        channelName={channelName}
                        layout="grid"
                        inLibrary={false}
                        onDownload={() => {
                          if (!entry.url || streamDownloading.has(entry.url))
                            return;
                          setStreamDownloading((prev) =>
                            new Set(prev).add(entry.url)
                          );
                          void submitDownload(entry.url, "1080p", {
                            title: entry.title ?? undefined,
                            channel: channelName,
                          })
                            .then(() =>
                              showToast("Download queued")
                            )
                            .catch((err: unknown) =>
                              showToast(
                                err instanceof Error
                                  ? err.message
                                  : "Could not start download"
                              )
                            )
                            .finally(() => {
                              setStreamDownloading((prev) => {
                                const next = new Set(prev);
                                next.delete(entry.url);
                                return next;
                              });
                            });
                        }}
                        downloading={streamDownloading.has(entry.url)}
                        skipRemotePreview
                      />
                    );
                  })}
                </div>
              </>
            )}
            {debouncedSearch && otherVideos.length > 0 && (
              <>
                <div className="flex items-center gap-3">
                  <hr className="min-w-0 flex-1 border-0 border-t border-ink-700" />
                  <span className="shrink-0 text-xs font-medium text-gray-400">
                    Other videos
                    <span className="ml-1.5 text-gray-500">
                      ({otherVideos.length})
                    </span>
                  </span>
                  <hr className="min-w-0 flex-1 border-0 border-t border-ink-700" />
                </div>
                <div
                  className={`grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 ${
                    settings.sidebarCollapsed
                      ? "xl:grid-cols-5"
                      : "xl:grid-cols-4"
                  }`}
                >
                  {otherVideos.map((v, idx) => (
                    <VideoCard
                      key={v.id}
                      video={v}
                      showViewCount={sort === "view_count"}
                      progress={
                        settings.showProgressOnAllVideos
                          ? videoProgress(v)
                          : undefined
                      }
                      selectable={selectMode}
                      selected={selectedIds.has(v.id)}
                      onSelect={(id, e) =>
                        toggleSelect(id, videos.length + idx, e.shiftKey)
                      }
                    />
                  ))}
                </div>
              </>
            )}
          </div>
        )}
        </div>

        {selectMode && selectedIds.size > 0 && (
          <LibraryBulkBar
            selectedCount={selectedIds.size}
            playlists={playlists}
            playlistOpen={playlistOpen}
            bulkNote={bulkNote}
            bulkNoteOpen={bulkNoteOpen}
            metadataSyncing={metadataSyncing}
            onTogglePlaylist={() => setPlaylistOpen(false)}
            onOpenPlaylistPicker={openPlaylistPicker}
            onAddToPlaylist={bulkAddToPlaylist}
            onToggleNote={() => setBulkNoteOpen((v) => !v)}
            onNoteChange={setBulkNote}
            onSaveNote={bulkSaveNote}
            onRefreshMetadata={bulkRefreshMetadata}
            onDownload={bulkDownload}
            onDelete={bulkDelete}
            onCancel={exitSelectMode}
          />
        )}
      </div>

      {showQueuePanel && queueDockedBottom && (
        <div
          style={queueDockStyle(miniPlayerActive ? miniPlayerRect : null)}
        >
          <div
            className={`pointer-events-auto w-96 ${queueDockAlignClass(
              miniPlayerActive ? miniPlayerRect : null
            )}`}
          >
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
