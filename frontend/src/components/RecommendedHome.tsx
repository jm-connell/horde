import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { aiStatusQuery } from "../queries/status";
import { useAuth } from "../context/AuthContext";
import { useDownloads } from "../context/DownloadContext";
import { useToast } from "../context/ToastContext";
import { useSettings } from "../hooks/useSettings";
import ChannelFeedCard from "./ChannelFeedCard";
import LoadingIndicator from "./LoadingIndicator";
import VideoCard from "./VideoCard";
import type {
  ChannelFeedEntry,
  RecommendationsResponse,
  Video,
} from "../types";
import { ChevronIcon } from "./icons";

const PAGE_SIZE = 24;

/** One card: a library video, or an indexed channel's upload not downloaded. */
type RecItem =
  | { key: string; video: Video; stream?: undefined }
  | { key: string; video?: undefined; stream: ChannelFeedEntry };

function recItems(data: RecommendationsResponse): RecItem[] {
  return data.sections.flatMap((section) =>
    (section.items ?? []).flatMap((item): RecItem[] =>
      item.video
        ? [{ key: `v${item.video.id}`, video: item.video }]
        : item.stream
          ? [
              {
                key: `s${item.stream.id ?? item.stream.url}`,
                stream: item.stream,
              },
            ]
          : []
    )
  );
}

export default function RecommendedHome({
  sidebarCollapsed,
}: {
  sidebarCollapsed: boolean;
}) {
  const { showToast, showError } = useToast();
  // Re-running the category job is AI worker control (administrators).
  const { isAdmin } = useAuth();
  const queryClient = useQueryClient();
  const [settings, updateSettings] = useSettings();
  const includeStreams = settings.recommendStreams;
  const { submitDownload } = useDownloads();
  const [downloading, setDownloading] = useState<Set<string>>(new Set());
  const [categories, setCategories] = useState<string[]>([]);
  const [feedVideos, setFeedVideos] = useState<RecItem[]>([]);
  const [feedOffset, setFeedOffset] = useState(0);
  const [feedHasMore, setFeedHasMore] = useState(false);
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const chipScrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  const chipClass = (selected: boolean) =>
    `ui-panel ui-interactive shrink-0 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
      selected
        ? "border-accent bg-accent/10 text-accent"
        : "border-ink-700 bg-ink-900 text-gray-300 hover:border-accent hover:text-accent"
    }`;

  const gridClass = `grid grid-cols-1 gap-4 max-sm:gap-0 max-sm:-mx-3 sm:grid-cols-2 md:grid-cols-3 ${
    sidebarCollapsed ? "xl:grid-cols-5" : "xl:grid-cols-4"
  }`;

  const updateChipScroll = useCallback(() => {
    const el = chipScrollRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 4);
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
  }, []);

  useEffect(() => {
    const el = chipScrollRef.current;
    if (!el) return;
    updateChipScroll();
    el.addEventListener("scroll", updateChipScroll, { passive: true });
    const ro = new ResizeObserver(updateChipScroll);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", updateChipScroll);
      ro.disconnect();
    };
  }, [categories, updateChipScroll]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    setFeedVideos([]);
    setFeedOffset(0);
    setFeedHasMore(false);
    api
      .getRecommendations(activeCategory || undefined, {
        limit: PAGE_SIZE,
        offset: 0,
        includeStreams,
      })
      .then((data) => {
        if (!active) return;
        setCategories(data.categories);
        const vids = recItems(data);
        setFeedVideos(vids);
        setFeedOffset(vids.length);
        setFeedHasMore(Boolean(data.has_more));
      })
      .catch(() => {
        if (!active) return;
        setError("Could not load recommendations.");
        setFeedVideos([]);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [activeCategory, reloadKey, includeStreams]);

  const loadMore = useCallback(async () => {
    if (loadingMore || !feedHasMore) return;
    setLoadingMore(true);
    try {
      const data = await api.getRecommendations(activeCategory || undefined, {
        limit: PAGE_SIZE,
        offset: feedOffset,
        includeStreams,
      });
      const vids = recItems(data);
      setFeedVideos((prev) => {
        const seen = new Set(prev.map((v) => v.key));
        return [...prev, ...vids.filter((v) => !seen.has(v.key))];
      });
      setFeedOffset((o) => o + vids.length);
      setFeedHasMore(Boolean(data.has_more && vids.length > 0));
    } catch {
      setFeedHasMore(false);
    } finally {
      setLoadingMore(false);
    }
  }, [activeCategory, loadingMore, feedHasMore, feedOffset, includeStreams]);

  const downloadStream = (entry: ChannelFeedEntry) => {
    if (!entry.url || downloading.has(entry.url)) return;
    setDownloading((prev) => new Set(prev).add(entry.url));
    void submitDownload(entry.url, "1080p", {
      title: entry.title ?? undefined,
      channel: entry.channel ?? "Unknown channel",
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
          next.delete(entry.url);
          return next;
        })
      );
  };

  useEffect(() => {
    if (!feedHasMore) return;
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void loadMore();
      },
      { rootMargin: "240px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [feedHasMore, loadMore]);

  const selectCategory = (name: string | null) => {
    setActiveCategory(name);
  };

  const scrollChips = (dir: -1 | 1) => {
    const el = chipScrollRef.current;
    if (!el) return;
    el.scrollBy({
      left: dir * Math.max(160, el.clientWidth * 0.6),
      behavior: "smooth",
    });
  };

  const refreshCategories = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const result = await api.processAiLibrary("categories");
      showToast(result.detail || "Category refresh queued");
      setReloadKey((k) => k + 1);

      const started = Date.now();
      const poll = async () => {
        while (Date.now() - started < 90_000) {
          await new Promise((r) => setTimeout(r, 2000));
          try {
            const status = await queryClient.fetchQuery({
              ...aiStatusQuery(),
              staleTime: 0,
            });
            const busy =
              status.queue_depth > 0 ||
              Boolean(status.current_job) ||
              Boolean(status.paused);
            setReloadKey((k) => k + 1);
            if (!busy && Date.now() - started > 2500) break;
          } catch {
            setReloadKey((k) => k + 1);
            break;
          }
        }
        setReloadKey((k) => k + 1);
      };
      void poll().finally(() => setRefreshing(false));
      return;
    } catch {
      showError("Could not refresh categories");
      setRefreshing(false);
    }
  };

  const showForYou = !activeCategory;

  return (
    <div className="space-y-6">
      <div className="relative flex items-center gap-2">
        {canScrollLeft && (
          <button
            type="button"
            onClick={() => scrollChips(-1)}
            className="ui-panel ui-interactive shrink-0 rounded-lg border border-ink-700 bg-ink-900 px-2.5 py-1.5 text-sm text-gray-300 hover:border-accent hover:text-accent"
            aria-label="Scroll categories left"
          >
            <ChevronIcon className="rotate-90" />
          </button>
        )}
        <div
          ref={chipScrollRef}
          className="flex min-w-0 flex-1 gap-2 overflow-x-auto pb-1 scrollbar-none [&::-webkit-scrollbar]:hidden"
        >
          <button
            type="button"
            onClick={() => selectCategory(null)}
            className={chipClass(!activeCategory)}
          >
            For you
          </button>
          {categories.map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => selectCategory(name)}
              className={chipClass(activeCategory === name)}
            >
              {name}
            </button>
          ))}
        </div>
        {canScrollRight && (
          <button
            type="button"
            onClick={() => scrollChips(1)}
            className="ui-panel ui-interactive shrink-0 rounded-lg border border-ink-700 bg-ink-900 px-2.5 py-1.5 text-sm text-gray-300 hover:border-accent hover:text-accent"
            aria-label="Scroll categories right"
          >
            <ChevronIcon className="-rotate-90" />
          </button>
        )}
        {showForYou && (
          <button
            type="button"
            aria-pressed={includeStreams}
            onClick={() =>
              updateSettings({ recommendStreams: !includeStreams })
            }
            title="Also suggest uploads that are not downloaded from channels you have indexed"
            className={chipClass(includeStreams)}
          >
            Include not downloaded
          </button>
        )}
        {showForYou && isAdmin && (
          <button
            type="button"
            onClick={refreshCategories}
            disabled={refreshing}
            title="Refresh recommendations and category shelves"
            className="ui-panel ui-interactive shrink-0 rounded-lg border border-ink-700 bg-ink-900 px-2.5 py-1.5 text-xs text-gray-400 hover:border-accent hover:text-accent disabled:opacity-50"
          >
            {refreshing ? "…" : "Refresh"}
          </button>
        )}
      </div>

      {loading ? (
        <LoadingIndicator />
      ) : error ? (
        <div className="py-16 text-center text-muted">
          <p className="text-sm">{error}</p>
        </div>
      ) : feedVideos.length === 0 ? (
        <div className="py-16 text-center text-muted">
          <p className="text-lg">No recommendations yet.</p>
          <p className="mt-1 text-sm">
            {showForYou
              ? "Watch a few videos or process your library under Settings → AI."
              : "No strong matches for this category. Try refreshing categories or lowering match strictness."}
          </p>
        </div>
      ) : (
        <>
          <div className={gridClass}>
            {feedVideos.map((item) =>
              item.video ? (
                <VideoCard key={item.key} video={item.video} layout="feed" />
              ) : (
                <ChannelFeedCard
                  key={item.key}
                  entry={item.stream}
                  channelName={item.stream.channel || "Unknown channel"}
                  layout="grid"
                  inLibrary={false}
                  onDownload={() => downloadStream(item.stream)}
                  downloading={downloading.has(item.stream.url)}
                  skipRemotePreview
                />
              )
            )}
          </div>
          <div ref={sentinelRef} className="h-4" />
          {loadingMore && <LoadingIndicator />}
        </>
      )}
    </div>
  );
}
