import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useAuth } from "../context/AuthContext";
import { useDownloads } from "../context/DownloadContext";
import { useToast } from "../context/ToastContext";
import { useSettings } from "../hooks/useSettings";
import type {
  ChannelFeedEntry,
  DiscoverItem,
  DiscoverStatus,
  SuggestedChannel,
} from "../types";
import { button } from "./buttons";
import ChannelFeedCard from "./ChannelFeedCard";
import RecMenu from "./discover/RecMenu";
import SuggestedChannels from "./discover/SuggestedChannels";
import LoadingIndicator from "./LoadingIndicator";
import VideoCard from "./VideoCard";

const PAGE_SIZE = 24;
/** The channel suggestions sit after this many cards. */
const SUGGESTIONS_AFTER = 8;
const STATUS_POLL_MS = 8000;
/** Stop asking after this long (the gatherer may be waiting on YouTube). */
const STATUS_POLL_MAX = 40;

type Source = DiscoverItem["source"];

/**
 * Where a card comes from, when source marks are on: a downloaded video gets a
 * solid success outline ("you have it"), a followed channel's a solid neutral
 * one (familiar), any other channel's a dashed accent one (new, not yours
 * yet). Each pair differs in color or in line style, and a dot of the same
 * kind leads the reason line, so the color is never the only tell.
 */
const SOURCE: Record<Source, { label: string; outline: string; dot: string }> =
  {
    library: {
      label: "In your library",
      outline: "border border-success/55",
      dot: "bg-success",
    },
    followed: {
      label: "From a channel you follow",
      outline: "border border-muted/60",
      dot: "bg-muted",
    },
    unfollowed: {
      label: "From a channel you don't follow",
      outline: "border border-dashed border-accent/60",
      dot: "ring-1 ring-inset ring-accent",
    },
  };

function SourceDot({ source }: { source: Source }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${SOURCE[source].dot}`}
    />
  );
}

type ChannelHit = { name: string; url: string | null };

function channelOf(item: DiscoverItem): ChannelHit {
  if (item.video) {
    return {
      name: item.video.channel ?? "",
      url: item.video.channel_url ?? null,
    };
  }
  return {
    name: item.stream?.channel ?? "",
    url: item.stream?.channel_url ?? null,
  };
}

function titleOf(item: DiscoverItem): string {
  return item.video?.title ?? item.stream?.title ?? "";
}

function newSeed(): number {
  return Math.floor(Math.random() * 2 ** 31);
}

/**
 * Recommended+: the library, indexed channels and videos found on YouTube,
 * mixed into one feed (familiar channels, more like what you watch, new
 * channels, and throwbacks), with channels to follow.
 */
export default function DiscoverHome({
  sidebarCollapsed,
  onChannelClick,
}: {
  sidebarCollapsed: boolean;
  onChannelClick: (hit: ChannelHit) => void;
}) {
  const { showToast, showError } = useToast();
  const { can } = useAuth();
  const { submitDownload } = useDownloads();
  const [settings, updateSettings] = useSettings();
  const marks = settings.recSourceMarks;
  // Undefined: the server's seed of the day, so a plain reload keeps the order.
  const [seed, setSeed] = useState<number | undefined>(undefined);
  const [reloadKey, setReloadKey] = useState(0);
  const [items, setItems] = useState<DiscoverItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<DiscoverStatus | null>(null);
  const [channels, setChannels] = useState<SuggestedChannel[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [freshReady, setFreshReady] = useState(false);
  const [downloading, setDownloading] = useState<Set<string>>(new Set());
  const sentinelRef = useRef<HTMLDivElement>(null);
  const runAtLoad = useRef<string | null>(null);
  // Bumped on every reload, so a "load more" answer for an older list is dropped.
  const generation = useRef(0);

  const gridClass = `grid grid-cols-1 gap-4 max-sm:gap-0 max-sm:-mx-3 sm:grid-cols-2 md:grid-cols-3 ${
    sidebarCollapsed ? "xl:grid-cols-5" : "xl:grid-cols-4"
  }`;

  useEffect(() => {
    let active = true;
    generation.current += 1;
    setLoading(true);
    setError(null);
    setFreshReady(false);
    api
      .getDiscoverFeed({ limit: PAGE_SIZE, seed })
      .then((page) => {
        if (!active) return;
        setItems(page.items);
        setCursor(page.next_cursor ?? null);
        setStatus(page.status);
        runAtLoad.current = page.status.last_run_at ?? null;
      })
      .catch(() => {
        if (active) setError("Could not load recommendations.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    api
      .getSuggestedChannels(seed)
      .then((data) => {
        if (active) setChannels(data.items);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [seed, reloadKey]);

  // While the gatherer works for us, watch for it to finish: an empty feed
  // reloads by itself, a full one offers the new picks.
  const gathering = Boolean(status?.gathering);
  const empty = items.length === 0;
  useEffect(() => {
    if (!gathering) return;
    let polls = 0;
    const timer = window.setInterval(() => {
      polls += 1;
      if (polls > STATUS_POLL_MAX) {
        window.clearInterval(timer);
        return;
      }
      api
        .getDiscoverStatus()
        .then((next) => {
          setStatus(next);
          const ran = next.last_run_at ?? null;
          if (next.gathering || ran === runAtLoad.current) return;
          runAtLoad.current = ran;
          if (empty) setReloadKey((k) => k + 1);
          else setFreshReady(true);
        })
        .catch(() => undefined);
    }, STATUS_POLL_MS);
    return () => window.clearInterval(timer);
  }, [gathering, empty]);

  const loadMore = useCallback(async () => {
    if (loadingMore || !cursor) return;
    const gen = generation.current;
    setLoadingMore(true);
    try {
      const page = await api.getDiscoverFeed({ cursor, limit: PAGE_SIZE });
      if (gen !== generation.current) return; // The list was reloaded meanwhile.
      setItems((prev) => {
        const seen = new Set(prev.map((i) => i.key));
        return [...prev, ...page.items.filter((i) => !seen.has(i.key))];
      });
      setCursor(page.next_cursor ?? null);
    } catch {
      if (gen === generation.current) setCursor(null);
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, loadingMore]);

  useEffect(() => {
    if (!cursor) return;
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void loadMore();
      },
      { rootMargin: "320px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [cursor, loadMore]);

  const refresh = () => {
    setSeed(newSeed());
    api
      .refreshDiscover()
      .then((r) => {
        if (r.queued) {
          showToast(r.detail);
          setStatus((s) => (s ? { ...s, gathering: true } : s));
        }
      })
      .catch(() => undefined);
  };

  const notInterested = (item: DiscoverItem) => {
    const index = items.findIndex((i) => i.key === item.key);
    const putBack = () =>
      setItems((prev) => {
        if (prev.some((i) => i.key === item.key)) return prev;
        const next = [...prev];
        next.splice(Math.max(0, index), 0, item);
        return next;
      });
    setItems((prev) => prev.filter((i) => i.key !== item.key));
    api
      .addRecFeedback("video", item.key, titleOf(item))
      .then((row) =>
        showToast("You won't see this video here again", {
          action: {
            label: "Undo",
            onClick: () => {
              void api.removeRecFeedback(row.id).catch(() => undefined);
              putBack();
            },
          },
        })
      )
      .catch(() => {
        showError("Could not save that");
        putBack();
      });
  };

  const blockChannel = (item: DiscoverItem) => {
    const { name, url } = channelOf(item);
    const removed = items.filter((i) => channelOf(i).name === name);
    setItems((prev) => prev.filter((i) => channelOf(i).name !== name));
    api
      .addRecFeedback("channel", url ?? "", name)
      .then((row) =>
        showToast(`You won't see ${name} here again`, {
          action: {
            label: "Undo",
            onClick: () => {
              void api.removeRecFeedback(row.id).catch(() => undefined);
              setReloadKey((k) => k + 1);
            },
          },
        })
      )
      .catch(() => {
        showError("Could not save that");
        setItems((prev) => [...prev, ...removed]);
      });
  };

  const followChannel = async (ch: SuggestedChannel) => {
    try {
      await api.followChannel(ch.url, ch.name);
      if (can("download") && !ch.indexed) {
        // Indexing lists the channel's uploads, so they join Recommended.
        await api
          .indexChannelCatalog({ url: ch.url, channel: ch.name })
          .catch(() => undefined);
      }
      setChannels((prev) => prev.filter((c) => c.url !== ch.url));
      showToast(`Following ${ch.name}`);
    } catch {
      showError(`Could not follow ${ch.name}`);
    }
  };

  const dismissChannel = (ch: SuggestedChannel) => {
    setChannels((prev) => prev.filter((c) => c.url !== ch.url));
    api
      .addRecFeedback("suggestion", ch.url, ch.name)
      .catch(() => showError("Could not save that"));
  };

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

  const statusLine = !status
    ? null
    : !status.enabled
      ? "Looking on YouTube is off (Settings → Library), so these come from your library and indexed channels."
      : status.backing_off
        ? "YouTube asked Horde to slow down; looking for new videos again later."
        : status.gathering
          ? "Looking on YouTube for videos you might like…"
          : null;

  const card = (item: DiscoverItem) => {
    const channel = channelOf(item);
    return (
      <div
        key={item.key}
        className="group/rec relative"
        data-rec-key={item.key}
      >
        <div className="relative">
          {item.video ? (
            <VideoCard video={item.video} layout="feed" />
          ) : item.stream ? (
            <ChannelFeedCard
              entry={item.stream}
              channelName={item.stream.channel || "Unknown channel"}
              layout="grid"
              inLibrary={false}
              onDownload={() => item.stream && downloadStream(item.stream)}
              downloading={downloading.has(item.stream.url)}
              skipRemotePreview
              onChannelClick={onChannelClick}
            />
          ) : null}
          {marks && (
            <span
              aria-hidden="true"
              className={`pointer-events-none absolute inset-0 rounded-xl max-sm:hidden ${SOURCE[item.source].outline}`}
            />
          )}
        </div>
        <p
          className="flex items-center gap-1.5 px-1 pt-1.5 text-xs text-muted max-sm:px-3 max-sm:pb-3"
          title={item.reason.detail ?? item.reason.text}
        >
          {marks && <SourceDot source={item.source} />}
          {marks && (
            <span className="sr-only">{SOURCE[item.source].label}.</span>
          )}
          <span className="truncate">{item.reason.text}</span>
        </p>
        <RecMenu
          channel={channel.name || null}
          onNotInterested={() => notInterested(item)}
          onBlockChannel={() => blockChannel(item)}
          className="absolute right-2 top-2 z-10 opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover/rec:opacity-100 [@media(hover:none)]:opacity-100"
        />
      </div>
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <p className="min-w-0 flex-1 text-sm text-muted" aria-live="polite">
          {statusLine ??
            "From your channels, more like what you watch, and channels new to you."}
        </p>
        {freshReady && (
          <button
            type="button"
            onClick={() => setReloadKey((k) => k + 1)}
            className={button("secondary", "sm")}
          >
            Show new picks
          </button>
        )}
        <button
          type="button"
          aria-pressed={marks}
          onClick={() => updateSettings({ recSourceMarks: !marks })}
          className={`${button("secondary", "sm")} ${marks ? "border-accent text-accent" : ""}`}
          title="Outline each video by where it comes from"
        >
          Sources
        </button>
        <button
          type="button"
          onClick={refresh}
          className={button("secondary", "sm")}
          title="Reshuffle, and look for new videos on YouTube"
        >
          Refresh
        </button>
      </div>
      {marks && items.length > 0 && (
        <ul
          aria-label="What the outlines mean"
          className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted"
        >
          {(Object.keys(SOURCE) as Source[]).map((source) => (
            <li key={source} className="flex items-center gap-1.5">
              <SourceDot source={source} />
              {SOURCE[source].label}
            </li>
          ))}
        </ul>
      )}

      {loading ? (
        <LoadingIndicator />
      ) : error ? (
        <div className="py-16 text-center text-muted">
          <p className="text-sm">{error}</p>
        </div>
      ) : items.length === 0 ? (
        <div className="py-16 text-center text-muted">
          <p className="text-lg">
            {gathering
              ? "Finding videos for you…"
              : "Nothing to recommend yet."}
          </p>
          <p className="mt-1 text-sm">
            {gathering
              ? "This takes a minute or two the first time."
              : "Watch a few videos, follow some channels, or index a channel's catalog."}
          </p>
        </div>
      ) : (
        <>
          <div className={gridClass}>
            {items.slice(0, SUGGESTIONS_AFTER).map(card)}
            <SuggestedChannels
              channels={channels}
              onFollow={followChannel}
              onDismiss={dismissChannel}
              onOpen={(ch) => onChannelClick({ name: ch.name, url: ch.url })}
            />
            {items.slice(SUGGESTIONS_AFTER).map(card)}
          </div>
          <div ref={sentinelRef} className="h-4" />
          {loadingMore && <LoadingIndicator />}
        </>
      )}
    </div>
  );
}
