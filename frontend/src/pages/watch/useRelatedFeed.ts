import { useEffect, useRef } from "react";
import { useRelatedVideos } from "../../queries/videos";

/** "More like this" for a video, loading the next page when the sentinel scrolls into view. */
export function useRelatedFeed(videoId: number | undefined) {
  const sentinelRef = useRef<HTMLDivElement>(null);
  const { videos, hasMore, loadingMore, loadMore } = useRelatedVideos(videoId);

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

  return { videos, loadingMore, sentinelRef };
}

export type RelatedFeed = ReturnType<typeof useRelatedFeed>;
