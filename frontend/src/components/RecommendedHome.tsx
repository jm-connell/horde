import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useToast } from "../context/ToastContext";
import LoadingIndicator from "./LoadingIndicator";
import VideoCard from "./VideoCard";
import type { Video } from "../types";

const PAGE_SIZE = 24;

export default function RecommendedHome({
  sidebarCollapsed,
}: {
  sidebarCollapsed: boolean;
}) {
  const { showToast } = useToast();
  const [categories, setCategories] = useState<string[]>([]);
  const [feedVideos, setFeedVideos] = useState<Video[]>([]);
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

  const gridClass = `grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 ${
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
      })
      .then((data) => {
        if (!active) return;
        setCategories(data.categories);
        const vids = data.sections.flatMap((s) => s.videos);
        setFeedVideos(vids);
        setFeedOffset(vids.length);
        setFeedHasMore(Boolean(data.has_more));
      })
      .catch(() => {
        if (!active) return;
        setError(
          "Could not load recommendations. Index more videos in Settings → AI."
        );
        setFeedVideos([]);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [activeCategory, reloadKey]);

  const loadMore = useCallback(async () => {
    if (loadingMore || !feedHasMore) return;
    setLoadingMore(true);
    try {
      const data = await api.getRecommendations(activeCategory || undefined, {
        limit: PAGE_SIZE,
        offset: feedOffset,
      });
      const vids = data.sections.flatMap((s) => s.videos);
      setFeedVideos((prev) => {
        const seen = new Set(prev.map((v) => v.id));
        return [...prev, ...vids.filter((v) => !seen.has(v.id))];
      });
      setFeedOffset((o) => o + vids.length);
      setFeedHasMore(Boolean(data.has_more && vids.length > 0));
    } catch {
      setFeedHasMore(false);
    } finally {
      setLoadingMore(false);
    }
  }, [activeCategory, loadingMore, feedHasMore, feedOffset]);

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
            const status = await api.getAiStatus();
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
      showToast("Could not refresh categories");
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
            ‹
          </button>
        )}
        <div
          ref={chipScrollRef}
          className="flex min-w-0 flex-1 gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
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
            ›
          </button>
        )}
        {showForYou && (
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
        <div className="py-16 text-center text-gray-500">
          <p className="text-sm">{error}</p>
        </div>
      ) : feedVideos.length === 0 ? (
        <div className="py-16 text-center text-gray-500">
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
            {feedVideos.map((v) => (
              <VideoCard key={v.id} video={v} />
            ))}
          </div>
          <div ref={sentinelRef} className="h-4" />
          {loadingMore && <LoadingIndicator />}
        </>
      )}
    </div>
  );
}
