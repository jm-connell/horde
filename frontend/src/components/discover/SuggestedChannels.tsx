import { useCallback, useEffect, useRef, useState } from "react";
import { useChannelPage } from "../../queries/follows";
import type { SuggestedChannel } from "../../types";
import { formatViewCount, joinDotList, youtubeThumbnailUrl } from "../../utils";
import { button } from "../buttons";
import ChannelAvatar from "../ChannelAvatar";
import { isYoutubeChannelUrl } from "../channelFeedYoutubeSearch";
import FadeImage from "../FadeImage";
import { ChevronIcon, CloseIcon } from "../icons";

const arrowClass =
  "ui-panel ui-interactive absolute top-1/2 z-20 -translate-y-1/2 rounded-lg border border-ink-700 bg-ink-900 px-2.5 py-1.5 text-sm text-gray-300 hover:border-accent hover:text-accent disabled:pointer-events-none";

/** One suggestion: the whole card opens the channel. */
function ChannelCard({
  ch,
  busy,
  onSubscribe,
  onDismiss,
  onOpen,
}: {
  ch: SuggestedChannel;
  busy: boolean;
  onSubscribe?: () => void;
  onDismiss: () => void;
  onOpen: () => void;
}) {
  const youtubeUrl = isYoutubeChannelUrl(ch.url) ? ch.url : null;
  // The channel's own bio (read with its avatar); says more than the stats.
  const { about } = useChannelPage(youtubeUrl);
  // What the channel is like, from the videos the feed picked.
  const stats = joinDotList([
    ch.typical_views != null ? `~${formatViewCount(ch.typical_views)}` : null,
    ch.typical_minutes != null ? `~${ch.typical_minutes} min videos` : null,
  ]);
  return (
    <div
      data-horde="suggested-channel"
      className="ui-panel group/sc relative flex w-64 shrink-0 flex-col gap-2 rounded-xl bg-ink-900 p-3 ring-1 ring-ink-700 transition-shadow hover:ring-accent/60"
    >
      {/* Covers the card; the buttons above it sit on top (z-10). */}
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Open ${ch.name}`}
        className="absolute inset-0 rounded-xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
      />
      <div className="pointer-events-none grid grid-cols-3 gap-1 overflow-hidden rounded-lg">
        {ch.videos.slice(0, 3).map((v) => (
          <FadeImage
            key={v.id ?? v.url}
            src={youtubeThumbnailUrl(v.id, v.thumbnail_url) ?? undefined}
            alt=""
            className="aspect-video w-full rounded-sm bg-ink-800 object-cover"
            fallback={
              <span className="block aspect-video w-full rounded-sm bg-ink-800" />
            }
          />
        ))}
      </div>
      <div className="pointer-events-none flex min-w-0 items-center gap-2">
        <ChannelAvatar
          channel={ch.name}
          channelUrl={youtubeUrl}
          size="h-9 w-9 text-sm"
        />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-gray-100 group-hover/sc:text-accent">
            {ch.name}
          </p>
          {stats && <p className="truncate text-xs text-muted">{stats}</p>}
        </div>
      </div>
      {(ch.tags ?? []).length > 0 && (
        // One line: a tag that does not fit is cut, never wrapped.
        <ul
          aria-label={`What ${ch.name} is about`}
          className="pointer-events-none flex min-w-0 gap-1 overflow-hidden"
        >
          {(ch.tags ?? []).map((tag) => (
            <li
              key={tag}
              className="min-w-0 shrink-0 truncate whitespace-nowrap rounded-full border border-ink-700 px-2 py-0.5 text-[11px] text-gray-300 last:shrink"
            >
              {tag}
            </li>
          ))}
        </ul>
      )}
      {about && (
        <p
          className="pointer-events-none line-clamp-2 text-xs text-muted"
          title={about}
        >
          {about}
        </p>
      )}
      {onSubscribe && (
        <button
          type="button"
          disabled={busy}
          onClick={onSubscribe}
          className={`${button("secondary", "sm")} relative z-10 mt-auto`}
        >
          {busy ? "Subscribing…" : "Subscribe"}
        </button>
      )}
      <button
        type="button"
        onClick={onDismiss}
        className="absolute right-2 top-2 z-10 flex h-7 w-7 items-center justify-center rounded-full bg-black/70 text-white shadow ring-1 ring-white/20 transition-colors hover:bg-black hover:ring-white/50"
        aria-label={`Don't suggest ${ch.name}`}
        title="Don't suggest this channel"
      >
        <CloseIcon />
      </button>
    </div>
  );
}

/**
 * "Channels you might like": subscribe to one, open it, or say no. Scrolls
 * sideways, and asks for more channels as it nears the end.
 */
export default function SuggestedChannels({
  channels,
  onSubscribe,
  onDismiss,
  onOpen,
  onLoadMore,
}: {
  channels: SuggestedChannel[];
  /** Absent when this account may not change its subscriptions. */
  onSubscribe?: (channel: SuggestedChannel) => Promise<void>;
  onDismiss: (channel: SuggestedChannel) => void;
  onOpen: (channel: SuggestedChannel) => void;
  /** Set while the server has more suggestions. */
  onLoadMore?: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(false);
  const loadMore = useRef(onLoadMore);
  loadMore.current = onLoadMore;

  const update = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    setCanLeft(el.scrollLeft > 4);
    setCanRight(max > 4 && el.scrollLeft < max - 4);
    // Within about two cards of the end: fetch the next page.
    if (max - el.scrollLeft < el.clientWidth) loadMore.current?.();
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, [channels.length, update]);

  if (channels.length === 0) return null;

  const scroll = (dir: -1 | 1) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * el.clientWidth * 0.8, behavior: "smooth" });
  };

  return (
    <section
      aria-label="Channels you might like"
      className="col-span-full py-2 max-sm:px-3"
    >
      <h2 className="mb-1 text-sm font-medium text-gray-200">
        Channels you might like
      </h2>
      <div className="relative">
        <button
          type="button"
          onClick={() => scroll(-1)}
          disabled={!canLeft}
          aria-hidden={!canLeft}
          tabIndex={canLeft ? undefined : -1}
          aria-label="Scroll channels left"
          className={`${arrowClass} -left-3 hidden sm:block ${canLeft ? "" : "invisible"}`}
        >
          <ChevronIcon className="rotate-90" />
        </button>
        <button
          type="button"
          onClick={() => scroll(1)}
          disabled={!canRight}
          aria-hidden={!canRight}
          tabIndex={canRight ? undefined : -1}
          aria-label="Scroll channels right"
          className={`${arrowClass} -right-3 hidden sm:block ${canRight ? "" : "invisible"}`}
        >
          <ChevronIcon className="-rotate-90" />
        </button>
        {/* Vertical padding so the cards' rings and hover lift are not clipped. */}
        <div
          ref={scrollRef}
          className="-mx-1 flex gap-3 overflow-x-auto px-1 py-2 scrollbar-none [&::-webkit-scrollbar]:hidden"
        >
          {channels.map((ch) => (
            <ChannelCard
              key={ch.url}
              ch={ch}
              busy={busy === ch.url}
              onSubscribe={
                onSubscribe
                  ? () => {
                      setBusy(ch.url);
                      void onSubscribe(ch).finally(() => setBusy(null));
                    }
                  : undefined
              }
              onDismiss={() => onDismiss(ch)}
              onOpen={() => onOpen(ch)}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
