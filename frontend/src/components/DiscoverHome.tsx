import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useAuth } from "../context/AuthContext";
import { useSubscribe } from "../queries/follows";
import { useDownloads } from "../context/DownloadContext";
import { useGridColumns } from "../hooks/useGridColumns";
import { normalizeChannelUrl } from "../utils/followUrl";
import { useAlgorithmPanelHere, useHelpChat } from "../context/HelpChatContext";
import { useToast } from "../context/ToastContext";
import {
  DISCOVER_PAGE_SIZE,
  DISCOVER_PREVIEW_MS,
  useRecTopics,
  useRecTuning,
} from "../queries/discover";
import { queryKeys } from "../queries/keys";
import type {
  ChannelFeedEntry,
  DiscoverFeed,
  DiscoverItem,
  DiscoverStatus,
  SuggestedChannel,
  SuggestedChannels as SuggestedChannelsPage,
} from "../types";
import { button } from "./buttons";
import CategoryChips from "./CategoryChips";
import ChannelFeedCard from "./ChannelFeedCard";
import RecMenu from "./discover/RecMenu";
import { SOURCE } from "./discover/sources";
import { useHideLive } from "./discover/useHideLive";
import SuggestedChannels from "./discover/SuggestedChannels";
import WhyDialog from "./discover/WhyDialog";
import LoadingIndicator from "./LoadingIndicator";
import VideoCard from "./VideoCard";
import { useSettings } from "../hooks/useSettings";

/**
 * How many cards come before the channel suggestions: three full rows (four
 * on a narrow grid), or as many full rows as there are, so no row above them
 * is left part-empty.
 */
function suggestionsAfter(columns: number, cards: number): number {
  const full = Math.floor(cards / columns) * columns;
  return Math.min(columns * (columns >= 3 ? 3 : 4), full || cards);
}
const STATUS_POLL_MS = 8000;
/** Stop asking after this long (the gatherer may be waiting on YouTube). */
const STATUS_POLL_MAX = 40;

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

/**
 * What to show at once: the first page loaded ahead or shown last time (kept
 * on this device across app restarts, see useKeptDiscoverPage). `recent` is
 * false when it is older than DISCOVER_PREVIEW_MS: newer picks are then
 * offered, not swapped in.
 */
function previewPage(
  queryClient: ReturnType<typeof useQueryClient>
):
  | { page: DiscoverFeed; recent: boolean; channels?: SuggestedChannelsPage }
  | undefined {
  const state = queryClient.getQueryState<DiscoverFeed>(
    queryKeys.discover.firstPage
  );
  if (!state?.data) return undefined;
  return {
    page: state.data,
    recent: Date.now() - state.dataUpdatedAt < DISCOVER_PREVIEW_MS,
    channels: queryClient.getQueryData<SuggestedChannelsPage>(
      queryKeys.discover.channels
    ),
  };
}

function newSeed(): number {
  return Math.floor(Math.random() * 2 ** 31);
}

/**
 * Recommended: the library, indexed channels and videos found on YouTube,
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
  const { subscribe } = useSubscribe();
  const { submitDownload } = useDownloads();
  const [settings] = useSettings();
  const queryClient = useQueryClient();
  const { algorithmOpen, setAlgorithmOpen } = useHelpChat();
  useAlgorithmPanelHere();
  const [whyItem, setWhyItem] = useState<DiscoverItem | null>(null);
  // Re-rank when the algorithm changes (the panel saves it; not on first load).
  const tuning = useRecTuning().data?.values;
  const topicsQuery = useRecTopics();
  // Topics settled (loaded, or failed: then tuning changes still re-rank).
  const topicsSettled = topicsQuery.isSuccess || topicsQuery.isError;
  const tuningKey = JSON.stringify(
    tuning && topicsSettled ? [tuning, topicsQuery.data?.items ?? []] : null
  );
  const lastTuning = useRef<string | null>(null);
  useEffect(() => {
    if (tuningKey === "null") return;
    if (lastTuning.current !== null && lastTuning.current !== tuningKey)
      setReloadKey((k) => k + 1);
    lastTuning.current = tuningKey;
  }, [tuningKey]);
  // Undefined: the server's seed of the day, so a plain reload keeps the order.
  const [seed, setSeed] = useState<number | undefined>(undefined);
  const [reloadKey, setReloadKey] = useState(0);
  /** The AI category open (null: the whole feed, "For you"). */
  const [category, setCategory] = useState<string | null>(null);
  // Loaded ahead by the home page (or shown last time): shown at once, then
  // asked for again quietly so the visit counts. The cards on screen never
  // change under the user: a recent page keeps its cards, an older one gets
  // "Show new picks" once the new page is in.
  const [previewState] = useState(() => previewPage(queryClient));
  const preview = previewState?.page;
  const quietLoad = useRef<"keep" | "offer" | null>(
    previewState ? (previewState.recent ? "keep" : "offer") : null
  );
  /** A newer first page waiting for "Show new picks". */
  const pendingPage = useRef<DiscoverFeed | null>(null);
  /** Cards the user took off ("Not interested", a blocked channel). */
  const removedKeys = useRef(new Set<string>());
  const [items, setItems] = useState<DiscoverItem[]>(
    () => preview?.items ?? []
  );
  const [cursor, setCursor] = useState<string | null>(
    () => preview?.next_cursor ?? null
  );
  const [status, setStatus] = useState<DiscoverStatus | null>(
    () => preview?.status ?? null
  );
  const [channels, setChannels] = useState<SuggestedChannel[]>(
    () => previewState?.channels?.items ?? []
  );
  const [channelsCursor, setChannelsCursor] = useState<string | null>(
    () => previewState?.channels?.next_cursor ?? null
  );
  const loadingChannels = useRef(false);
  const [loading, setLoading] = useState(!preview);
  const [categories, setCategories] = useState<string[]>(
    () => preview?.categories ?? []
  );
  /** Re-ranking with cards on screen: keep them, dimmed, instead of a spinner. */
  const [updating, setUpdating] = useState(false);
  const hasItems = useRef(false);
  hasItems.current = items.length > 0;
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [freshReady, setFreshReady] = useState(false);
  const [downloading, setDownloading] = useState<Set<string>>(new Set());
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [columns, gridRef] = useGridColumns(4);
  const splitAt = suggestionsAfter(columns, items.length);
  const runAtLoad = useRef<string | null>(null);
  // Bumped on every reload, so a "load more" answer for an older list is dropped.
  const generation = useRef(0);

  const gridClass = `grid grid-cols-1 gap-4 max-sm:gap-0 max-sm:-mx-3 sm:grid-cols-2 md:grid-cols-3 ${
    sidebarCollapsed ? "xl:grid-cols-5" : "xl:grid-cols-4"
  }`;

  /** Show a first page (fresh from the server, or one held back). */
  const applyPage = useCallback(
    (page: DiscoverFeed) => {
      // A card taken off while this was loading stays off.
      setItems(page.items.filter((i) => !removedKeys.current.has(i.key)));
      setCategories(page.categories ?? []);
      setCursor(page.next_cursor ?? null);
      setStatus(page.status);
      queryClient.setQueryData(queryKeys.discover.mix, page.mix ?? []);
      queryClient.setQueryData(queryKeys.discover.blocked, page.blocked ?? []);
      runAtLoad.current = page.status.last_run_at ?? null;
    },
    [queryClient]
  );

  useEffect(() => {
    let active = true;
    generation.current += 1;
    const quiet = quietLoad.current;
    quietLoad.current = null;
    pendingPage.current = null;
    if (quiet) {
      // Cards from the preview are on screen already.
    } else if (hasItems.current) setUpdating(true);
    else setLoading(true);
    setError(null);
    setFreshReady(false);
    const wholeFeed = seed === undefined && category === null;
    api
      .getDiscoverFeed({
        limit: DISCOVER_PAGE_SIZE,
        seed,
        category: category ?? undefined,
      })
      .then((page) => {
        if (!active) return;
        if (quiet === "keep") {
          // Same day's order, a moment later: keep the cards in place.
          setStatus(page.status);
          setCategories(page.categories ?? []);
          queryClient.setQueryData(queryKeys.discover.mix, page.mix ?? []);
          queryClient.setQueryData(
            queryKeys.discover.blocked,
            page.blocked ?? []
          );
          runAtLoad.current = page.status.last_run_at ?? null;
          return;
        }
        if (quiet === "offer") {
          // An older page is on screen: offer the new one instead of swapping.
          pendingPage.current = page;
          setStatus(page.status);
          setFreshReady(true);
          return;
        }
        applyPage(page);
        // Today's order: shown at once the next time the tab opens.
        if (wholeFeed)
          queryClient.setQueryData(queryKeys.discover.firstPage, page);
      })
      .catch(() => {
        if (active && !quiet) setError("Could not load recommendations.");
      })
      .finally(() => {
        if (active) {
          setLoading(false);
          setUpdating(false);
        }
      });
    // The channel shelf is part of the whole feed only. With cards kept from
    // a preview, so is the shelf beside them.
    if (category === null && !quiet)
      api
        .getSuggestedChannels(seed)
        .then((data) => {
          if (!active) return;
          setChannels(data.items);
          setChannelsCursor(data.next_cursor ?? null);
          if (seed === undefined)
            queryClient.setQueryData(queryKeys.discover.channels, data);
        })
        .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [seed, reloadKey, category, queryClient, applyPage]);

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
      const page = await api.getDiscoverFeed({
        cursor,
        limit: DISCOVER_PAGE_SIZE,
        category: category ?? undefined,
      });
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
  }, [cursor, loadingMore, category]);

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

  /** The page loaded ahead no longer matches: the next open asks afresh. */
  const dropPreview = () => {
    queryClient.removeQueries({ queryKey: queryKeys.discover.firstPage });
    queryClient.removeQueries({ queryKey: queryKeys.discover.channels });
  };

  const notInterested = (item: DiscoverItem) => {
    dropPreview();
    removedKeys.current.add(item.key);
    const index = items.findIndex((i) => i.key === item.key);
    const putBack = () => {
      removedKeys.current.delete(item.key);
      setItems((prev) => {
        if (prev.some((i) => i.key === item.key)) return prev;
        const next = [...prev];
        next.splice(Math.max(0, index), 0, item);
        return next;
      });
    };
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
    const forget = () =>
      removed.forEach((i) => removedKeys.current.delete(i.key));
    dropPreview();
    removed.forEach((i) => removedKeys.current.add(i.key));
    setItems((prev) => prev.filter((i) => channelOf(i).name !== name));
    api
      .addRecFeedback("channel", url ?? "", name)
      .then((row) =>
        showToast(`You won't see ${name} here again`, {
          action: {
            label: "Undo",
            onClick: () => {
              void api.removeRecFeedback(row.id).catch(() => undefined);
              forget();
              setReloadKey((k) => k + 1);
            },
          },
        })
      )
      .catch(() => {
        showError("Could not save that");
        forget();
        setItems((prev) => [...prev, ...removed]);
      });
  };

  const hideLive = useHideLive((url) =>
    setItems((prev) =>
      prev.filter(
        (i) =>
          !(
            i.reason.kind === "live" &&
            i.stream?.channel_url &&
            (normalizeChannelUrl(i.stream.channel_url) ??
              i.stream.channel_url) === url
          )
      )
    )
  );

  const subscribeChannel = async (ch: SuggestedChannel) => {
    dropPreview();
    try {
      await subscribe(ch.url, ch.name);
      if (can("download") && !ch.indexed) {
        // Indexing lists the channel's uploads, so they join Recommended.
        await api
          .indexChannelCatalog({ url: ch.url, channel: ch.name })
          .catch(() => undefined);
      }
      setChannels((prev) => prev.filter((c) => c.url !== ch.url));
      showToast(`Subscribed to ${ch.name}`);
    } catch {
      showError(`Could not subscribe to ${ch.name}`);
    }
  };

  const loadMoreChannels = () => {
    if (!channelsCursor || loadingChannels.current) return;
    loadingChannels.current = true;
    api
      .getSuggestedChannels(undefined, undefined, channelsCursor)
      .then((data) => {
        setChannels((prev) => {
          const seen = new Set(prev.map((c) => c.url));
          return [...prev, ...data.items.filter((c) => !seen.has(c.url))];
        });
        setChannelsCursor(data.next_cursor ?? null);
      })
      .catch(() => setChannelsCursor(null))
      .finally(() => {
        loadingChannels.current = false;
      });
  };

  const dismissChannel = (ch: SuggestedChannel) => {
    dropPreview();
    setChannels((prev) => prev.filter((c) => c.url !== ch.url));
    api
      .addRecFeedback("suggestion", ch.url, ch.name)
      .catch(() => showError("Could not save that"));
  };

  const downloadStream = (entry: ChannelFeedEntry) => {
    if (!entry.url || downloading.has(entry.url)) return;
    setDownloading((prev) => new Set(prev).add(entry.url));
    void submitDownload(entry.url, settings.defaultDownloadPreset, {
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

  const actions = (
    <>
      {freshReady && (
        <button
          type="button"
          onClick={() => {
            const page = pendingPage.current;
            if (!page) {
              setReloadKey((k) => k + 1);
              return;
            }
            pendingPage.current = null;
            setFreshReady(false);
            applyPage(page);
            queryClient.setQueryData(queryKeys.discover.firstPage, page);
            // The shelf goes with the new cards.
            api
              .getSuggestedChannels()
              .then((data) => {
                setChannels(data.items);
                setChannelsCursor(data.next_cursor ?? null);
                queryClient.setQueryData(queryKeys.discover.channels, data);
              })
              .catch(() => undefined);
          }}
          className={button("secondary", "sm")}
        >
          Show new picks
        </button>
      )}
      <button
        type="button"
        aria-pressed={algorithmOpen}
        onClick={() => setAlgorithmOpen(!algorithmOpen)}
        className={`${button("secondary", "sm")} ${algorithmOpen ? "border-accent text-accent" : ""}`}
        title="See and change how this feed is picked"
        data-horde="open-algorithm"
      >
        Algorithm
      </button>
      <button
        type="button"
        onClick={refresh}
        className={button("secondary", "sm")}
        title={
          status?.enabled === false
            ? "Reshuffle the less certain picks"
            : "Reshuffle, and look for new videos on YouTube"
        }
      >
        Refresh
      </button>
    </>
  );

  const card = (item: DiscoverItem) => {
    const channel = channelOf(item);
    return (
      <div
        key={item.key}
        className="group/rec relative"
        data-rec-key={item.key}
        // Why it is here, on hover; the outline already says where it is from.
        title={item.reason.detail ?? item.reason.text}
      >
        <span className="sr-only">{SOURCE[item.source].label}.</span>
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
        {/* A live card has its own red ring; a second outline would sit inside it. */}
        {SOURCE[item.source].outline && item.reason.kind !== "live" && (
          <span
            aria-hidden="true"
            data-horde="source-outline"
            className={`pointer-events-none absolute inset-0 sm:rounded-xl ${SOURCE[item.source].outline}`}
          />
        )}
        <RecMenu
          channel={channel.name || null}
          onWhy={() => setWhyItem(item)}
          onNotInterested={() => notInterested(item)}
          onBlockChannel={() => blockChannel(item)}
          onHideLive={
            item.reason.kind === "live" && item.stream?.channel_url
              ? () =>
                  item.stream?.channel_url &&
                  hideLive(item.stream.channel_url, channel.name || null)
              : undefined
          }
          className="absolute right-2 top-2 z-10 opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover/rec:opacity-100 [@media(hover:none)]:opacity-100"
        />
      </div>
    );
  };

  return (
    <div className="space-y-4">
      {statusLine && (
        <p className="text-sm text-muted" aria-live="polite">
          {statusLine}
        </p>
      )}
      {categories.length > 0 ? (
        <CategoryChips
          categories={categories}
          active={category}
          onSelect={setCategory}
        >
          {actions}
        </CategoryChips>
      ) : (
        <div className="flex flex-wrap items-center justify-end gap-3">
          {actions}
        </div>
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
              : "Watch a few videos, subscribe to some channels, or index a channel's catalog."}
          </p>
        </div>
      ) : (
        <>
          <div
            ref={gridRef}
            className={`${gridClass} transition-opacity duration-200 ${updating ? "opacity-60" : ""}`}
            aria-busy={updating || undefined}
          >
            {items.slice(0, splitAt).map(card)}
            <SuggestedChannels
              channels={category === null ? channels : []}
              onSubscribe={
                can("manage_subscriptions") ? subscribeChannel : undefined
              }
              onDismiss={dismissChannel}
              onOpen={(ch) => onChannelClick({ name: ch.name, url: ch.url })}
              onLoadMore={channelsCursor ? loadMoreChannels : undefined}
            />
            {items.slice(splitAt).map(card)}
          </div>
          <div ref={sentinelRef} className="h-4" />
          {loadingMore && <LoadingIndicator />}
        </>
      )}
      {whyItem && (
        <WhyDialog
          item={whyItem}
          onClose={() => setWhyItem(null)}
          onOpenAlgorithm={() => {
            setWhyItem(null);
            setAlgorithmOpen(true);
          }}
        />
      )}
    </div>
  );
}
