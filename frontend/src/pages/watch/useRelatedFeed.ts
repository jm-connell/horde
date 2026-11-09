import { useEffect, useRef } from "react";
import { useRelatedVideos } from "../../queries/videos";

/** A sentinel element that calls `loadMore` when it scrolls into view. */
export function useLoadMoreSentinel(hasMore: boolean, loadMore: () => void) {
  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!hasMore) return;
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMore();
      },
      { rootMargin: "200px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, loadMore]);
  return sentinelRef;
}

/** "More like this" for a video, loading the next page when the sentinel scrolls into view. */
export function useRelatedFeed(videoId: number | undefined) {
  const { videos, hasMore, loadingMore, loadMore } = useRelatedVideos(videoId);
  const sentinelRef = useLoadMoreSentinel(hasMore, loadMore);
  return { videos, loadingMore, sentinelRef };
}

export type RelatedFeed = ReturnType<typeof useRelatedFeed>;
