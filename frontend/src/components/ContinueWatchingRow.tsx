import { useCallback, useEffect, useRef, useState } from "react";
import type { Video } from "../types";
import VideoCard from "./VideoCard";

interface Props {
  videos: Video[];
  showProgress?: boolean;
  onDismiss: (id: number) => void;
  onDismissAll: (ids: number[]) => void;
}

function watchProgress(video: Video): number | undefined {
  if (!video.duration_sec || video.duration_sec <= 0) return undefined;
  if (video.last_position_sec <= 0) return undefined;
  return Math.min(1, video.last_position_sec / video.duration_sec);
}

const arrowClass =
  "ui-panel ui-interactive absolute top-1/2 z-10 -translate-y-1/2 rounded-lg border border-ink-700 bg-ink-900 px-2.5 py-1.5 text-sm text-gray-300 hover:border-accent hover:text-accent disabled:pointer-events-none";

export default function ContinueWatchingRow({
  videos,
  showProgress = true,
  onDismiss,
  onDismissAll,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollingRef = useRef(false);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const updateScrollState = useCallback(() => {
    const el = scrollRef.current;
    if (!el || scrollingRef.current) return;
    const maxScroll = el.scrollWidth - el.clientWidth;
    setCanScrollLeft(el.scrollLeft > 4);
    setCanScrollRight(maxScroll > 4 && el.scrollLeft < maxScroll - 4);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    updateScrollState();
    el.addEventListener("scroll", updateScrollState, { passive: true });
    const ro = new ResizeObserver(updateScrollState);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", updateScrollState);
      ro.disconnect();
    };
  }, [videos, updateScrollState]);

  const scrollByDir = (dir: -1 | 1) => {
    const el = scrollRef.current;
    if (!el || scrollingRef.current) return;
    const row = el.querySelector<HTMLElement>(":scope > div");
    const card = row?.querySelector<HTMLElement>(":scope > div");
    const gap = row
      ? Number.parseFloat(getComputedStyle(row).columnGap) || 16
      : 16;
    const step = card ? card.offsetWidth + gap : el.clientWidth * 0.75;
    if (step <= 0) return;
    const visibleCount = Math.max(1, Math.floor(el.clientWidth / step));
    const page = Math.max(1, visibleCount - 1);
    const maxScroll = el.scrollWidth - el.clientWidth;
    const target = Math.max(
      0,
      Math.min(maxScroll, el.scrollLeft + dir * page * step),
    );
    if (Math.abs(target - el.scrollLeft) < 4) return;

    scrollingRef.current = true;
    el.scrollTo({ left: target, behavior: "smooth" });
    const done = () => {
      if (!scrollingRef.current) return;
      scrollingRef.current = false;
      updateScrollState();
    };
    el.addEventListener("scrollend", done, { once: true });
    globalThis.setTimeout(done, 500);
  };

  if (videos.length === 0) return null;

  return (
    <section className="mb-6">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-400">
          Continue watching
        </h2>
        <button
          onClick={() => onDismissAll(videos.map((v) => v.id))}
          className="text-xs text-gray-500 hover:text-accent"
        >
          Clear all
        </button>
      </div>

      <div className="relative px-1 sm:px-2">
        <button
          type="button"
          onClick={() => scrollByDir(-1)}
          disabled={!canScrollLeft}
          aria-hidden={!canScrollLeft}
          aria-label="Scroll left"
          className={`${arrowClass} -left-3 hidden sm:block ${canScrollLeft ? "" : "invisible"}`}
        >
          ‹
        </button>
        <button
          type="button"
          onClick={() => scrollByDir(1)}
          disabled={!canScrollRight}
          aria-hidden={!canScrollRight}
          aria-label="Scroll right"
          className={`${arrowClass} -right-3 hidden sm:block ${canScrollRight ? "" : "invisible"}`}
        >
          ›
        </button>

        <div
          ref={scrollRef}
          className="overflow-x-auto scroll-smooth px-1 py-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          <div className="flex gap-4">
            {videos.map((v) => (
              <div
                key={v.id}
                className="group relative w-56 shrink-0 sm:w-64"
              >
                <button
                  onClick={() => onDismiss(v.id)}
                  className="absolute left-2 top-2 z-10 rounded-full bg-black/70 px-1.5 py-0.5 text-xs text-gray-300 opacity-100 hover:bg-black hover:text-white sm:opacity-0 sm:group-hover:opacity-100"
                  title="Remove from continue watching"
                  aria-label="Remove from continue watching"
                >
                  ✕
                </button>
                <VideoCard
                  video={v}
                  progress={showProgress ? watchProgress(v) : undefined}
                />
              </div>
            ))}
          </div>
        </div>
      </div>

      <hr className="mt-8 border-ink-700/80" />
    </section>
  );
}
