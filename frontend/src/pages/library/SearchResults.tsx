import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import ChannelFeedCard from "../../components/ChannelFeedCard";
import type { ChannelFeedEntry, Video } from "../../types";
import { YOUTUBE_SEARCH_LOAD_MORE_LABEL } from "../libraryCatalogProgress";
import { useSearch } from "../../context/SearchContext";
import LibraryGrid, { type LibraryGridOptions } from "./LibraryGrid";
import { videoGridClassName } from "./videoGridClassName";
import type { useGlobalSearch } from "./useGlobalSearch";
import { ChevronIcon } from "../../components/icons";
import { button } from "../../components/buttons";
import { useAskChannels, useAskSearch } from "../../queries/ask";
import { groupByVideo } from "../ask/askLinks";
import SaidInVideos from "./SaidInVideos";
import { useSettings } from "../../hooks/useSettings";
import MixedResults from "./MixedResults";
import {
  arrangeResults,
  layoutItems,
  scoreResults,
  type MixedLayout,
} from "./mixResults";

/** Transcript search covers every Ask channel. */
const ALL_CHANNELS: number[] = [];

function SearchResultSection({
  id,
  title,
  source,
  count,
  emptyText,
  loading = false,
  defaultOpen = true,
  footer,
  children,
}: {
  id: string;
  title: string;
  /** Where these results come from, in a few words. */
  source: string;
  count: number;
  emptyText: string;
  loading?: boolean;
  defaultOpen?: boolean;
  footer?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();
  return (
    <section id={id} className="scroll-mt-24 space-y-3" aria-busy={loading}>
      <div className="flex items-center gap-3">
        <button
          type="button"
          className="ui-interactive inline-flex shrink-0 items-baseline gap-2 rounded-md py-1 pr-1.5 text-left"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((v) => !v)}
        >
          <span
            className={`inline-block self-center text-[0.65rem] leading-none text-muted transition-transform ${
              open ? "" : "-rotate-90"
            }`}
            aria-hidden
          >
            <ChevronIcon />
          </span>
          <span className="text-sm font-semibold text-gray-100">{title}</span>
          <span className="text-xs text-muted">
            {loading ? "Searching…" : count}
          </span>
        </button>
        <span className="hidden truncate text-xs text-muted sm:inline">
          {source}
        </span>
        <hr className="min-w-0 flex-1 border-0 border-t border-ink-700" />
      </div>
      <div id={bodyId} hidden={!open} className="space-y-4">
        {loading ? null : count > 0 ? (
          <>
            {children}
            {footer}
          </>
        ) : (
          <p className="py-2 text-sm text-muted" role="status">
            {emptyText}
          </p>
        )}
      </div>
    </section>
  );
}

/** Jump links to each section, with its count or that it is still searching. */
function SectionStrip({
  items,
}: {
  items: { id: string; label: string; count: number; loading?: boolean }[];
}) {
  return (
    <nav aria-label="Search results" className="flex flex-wrap gap-2">
      {items.map((item) => (
        <a
          key={item.id}
          href={`#${item.id}`}
          onClick={(e) => {
            e.preventDefault();
            document
              .getElementById(item.id)
              ?.scrollIntoView({ behavior: "smooth", block: "start" });
          }}
          className="ui-interactive inline-flex items-center gap-1.5 rounded-full border border-ink-700 bg-ink-900 px-3 py-1 text-xs text-gray-300 hover:border-ink-600"
        >
          {item.label}
          {item.loading ? (
            <span
              className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent motion-reduce:animate-none"
              aria-label="searching"
            />
          ) : (
            <span className={item.count ? "text-gray-100" : "text-muted"}>
              {item.count}
            </span>
          )}
        </a>
      ))}
    </nav>
  );
}

/** Cards for videos that are not in the library yet; each can be downloaded. */
function RemoteEntryGrid({
  entries,
  searchQuery,
  global,
  onChannelClick,
  sidebarCollapsed,
}: {
  entries: ChannelFeedEntry[];
  searchQuery: string;
  global: ReturnType<typeof useGlobalSearch>;
  onChannelClick: (hit: { name: string; url: string | null }) => void;
  sidebarCollapsed: boolean;
}) {
  return (
    <div className={videoGridClassName(sidebarCollapsed)}>
      {entries.map((entry) => {
        const channelName = entry.channel || "Unknown channel";
        return (
          <ChannelFeedCard
            key={entry.id || entry.url}
            entry={entry}
            channelName={channelName}
            layout="grid"
            inLibrary={false}
            searchQuery={searchQuery}
            onDownload={() => global.queueRemoteDownload(entry)}
            downloading={global.streamDownloading.has(entry.url)}
            skipRemotePreview
            onChannelClick={onChannelClick}
          />
        );
      })}
    </div>
  );
}

/** Switch between one mixed list and a section per source. */
function LayoutToggle({
  value,
  onChange,
}: {
  value: "mixed" | "sections";
  onChange: (next: "mixed" | "sections") => void;
}) {
  const options = [
    { value: "mixed", label: "Mixed" },
    { value: "sections", label: "Sections" },
  ] as const;
  return (
    <div
      role="group"
      aria-label="Results layout"
      className="ui-panel inline-flex shrink-0 gap-0.5 rounded-lg bg-ink-900 p-0.5 ring-1 ring-ink-700"
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={`ui-interactive rounded-md px-2.5 py-1 text-xs font-medium ${
            value === o.value
              ? "bg-ink-800 text-gray-100"
              : "text-gray-400 hover:text-gray-200"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** A home-page search: the library matches, then everything else worth showing. */
export default function SearchResults({
  query,
  videos,
  otherVideos,
  librarySettled,
  onSelectableOrder,
  global,
  grid,
  onChannelClick,
}: {
  query: string;
  videos: Video[];
  otherVideos: Video[];
  /** Both library lists are fully loaded for this query. */
  librarySettled: boolean;
  /** The library videos in the order shown, for select mode (null: the default). */
  onSelectableOrder: (ids: number[] | null) => void;
  global: ReturnType<typeof useGlobalSearch>;
  grid: LibraryGridOptions;
  onChannelClick: (hit: { name: string; url: string | null }) => void;
}) {
  const { sidebarCollapsed } = grid;
  const { youtubeVideoSearch } = useSearch();
  // YouTube is searched a moment after typing stops and takes a second or two:
  // show its heading from the start, marked as searching.
  const youtubeOn = youtubeVideoSearch && query.trim().length >= 2;
  const youtubeSettled =
    youtubeOn &&
    !global.youtubeLoading &&
    global.youtubeResultsFor === query.trim();
  const youtubePending = youtubeOn && !youtubeSettled;
  // What Ask channels said, once one has captions indexed. Keyword search,
  // so it works without an AI provider.
  const askChannels = useAskChannels();
  const saidOn = askChannels.data?.items.some((c) => c.passages > 0) ?? false;
  const said = useAskSearch(saidOn ? query.trim() : "", ALL_CHANNELS);
  const saidGroups = useMemo(() => groupByVideo(said.hits), [said.hits]);

  const [settings, update] = useSettings();
  const mixed = settings.searchLayout !== "sections";
  const toggle = (
    <LayoutToggle
      value={mixed ? "mixed" : "sections"}
      onChange={(next) => update({ searchLayout: next })}
    />
  );
  // Mixed: score every source on one scale, then lay the results out so
  // nothing on screen moves while sources answer late or reload.
  const scored = useMemo(
    () =>
      scoreResults({
        query,
        library: videos,
        otherLibrary: otherVideos,
        stream: global.streamResults,
        said: said.hits,
        youtube: youtubeOn ? global.youtubeVisible : [],
      }),
    [
      query,
      videos,
      otherVideos,
      global.streamResults,
      said.hits,
      youtubeOn,
      global.youtubeVisible,
    ]
  );
  const localSettled =
    librarySettled &&
    !global.streamLoading &&
    global.streamResultsFor === query &&
    !askChannels.isPending &&
    (!saidOn || said.isError || (said.isSuccess && !said.isPlaceholderData));
  const layoutRef = useRef<MixedLayout | null>(null);
  const layout = useMemo(
    () =>
      mixed
        ? arrangeResults(layoutRef.current, scored, {
            query,
            localSettled,
            youtubeOn,
            youtubeSettled,
          })
        : null,
    [mixed, scored, query, localSettled, youtubeOn, youtubeSettled]
  );
  useEffect(() => {
    layoutRef.current = layout;
  }, [layout]);
  const mixedItems = useMemo(
    () => (layout ? layoutItems(layout) : []),
    [layout]
  );
  // Select mode follows the cards as shown: the mixed library cards, then
  // the rest of the library.
  const selectableOrder = useMemo(() => {
    if (!mixed) return null;
    const shown = mixedItems.flatMap((item) =>
      item.kind === "library" ? [item.video.id] : []
    );
    const shownIds = new Set(shown);
    return [
      ...shown,
      ...otherVideos.flatMap((v) => (shownIds.has(v.id) ? [] : [v.id])),
    ];
  }, [mixed, mixedItems, otherVideos]);
  useEffect(() => {
    onSelectableOrder(selectableOrder);
  }, [selectableOrder, onSelectableOrder]);
  useEffect(() => () => onSelectableOrder(null), [onSelectableOrder]);
  const selectIndex = useMemo(
    () => new Map((selectableOrder ?? []).map((id, i) => [id, i])),
    [selectableOrder]
  );

  if (mixed) {
    const mixedLoading = layout === null;
    const shownIds = new Set(
      mixedItems.flatMap((item) =>
        item.kind === "library" ? [item.video.id] : []
      )
    );
    const rest = otherVideos.filter((v) => !shownIds.has(v.id));
    const results = mixedItems.filter((item) => item.kind !== "slot").length;
    return (
      <div className="space-y-8">
        <section
          aria-labelledby="search-mixed-title"
          aria-busy={mixedLoading || youtubePending}
          className="space-y-4"
        >
          <div className="flex items-center gap-3">
            <h2
              id="search-mixed-title"
              className="text-sm font-semibold text-gray-100"
            >
              Results{" "}
              <span
                className="text-xs font-normal text-muted"
                aria-live="polite"
              >
                {mixedLoading ? "Searching…" : results}
              </span>
            </h2>
            <span className="hidden truncate text-xs text-muted sm:inline">
              Your library first, then what you can stream
            </span>
            <hr className="min-w-0 flex-1 border-0 border-t border-ink-700" />
            {toggle}
          </div>
          <MixedResults
            items={mixedItems}
            loading={mixedLoading}
            query={query}
            grid={grid}
            global={global}
            selectIndex={selectIndex}
            onChannelClick={onChannelClick}
          />
          {(global.youtubeHasMore || (saidOn && said.hasNextPage)) &&
            !mixedLoading && (
              <div className="flex flex-wrap justify-center gap-2">
                {saidOn && said.hasNextPage && (
                  <button
                    type="button"
                    className={button("secondary")}
                    disabled={said.isFetchingNextPage}
                    onClick={() => void said.fetchNextPage()}
                  >
                    {said.isFetchingNextPage
                      ? "Loading…"
                      : "More of what was said"}
                  </button>
                )}
                {global.youtubeHasMore && (
                  <button
                    type="button"
                    className={button("secondary")}
                    disabled={global.youtubeLoadingMore}
                    onClick={() => global.loadMoreYoutube()}
                  >
                    {global.youtubeLoadingMore
                      ? "Loading…"
                      : YOUTUBE_SEARCH_LOAD_MORE_LABEL}
                  </button>
                )}
              </div>
            )}
        </section>
        <SearchResultSection
          id="search-other"
          title="Rest of your library"
          source="Everything else, not matching"
          count={rest.length}
          emptyText="No other videos in your library."
          defaultOpen={false}
        >
          <LibraryGrid
            videos={rest}
            indexOffset={shownIds.size}
            searchQuery={query}
            options={grid}
          />
        </SearchResultSection>
      </div>
    );
  }
  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <SectionStrip
          items={[
            {
              id: "search-library",
              label: "In your library",
              count: videos.length,
            },
            ...(saidOn
              ? [
                  {
                    id: "search-said",
                    label: "Said in videos",
                    count: saidGroups.length,
                    loading: said.isLoading,
                  },
                ]
              : []),
            {
              id: "search-stream",
              label: "Stream",
              count: global.streamResults.length,
              loading: global.streamLoading,
            },
            ...(youtubeOn
              ? [
                  {
                    id: "search-youtube",
                    label: "YouTube",
                    count: global.youtubeVisible.length,
                    loading: youtubePending,
                  },
                ]
              : []),
            {
              id: "search-other",
              label: "Rest of library",
              count: otherVideos.length,
            },
          ]}
        />
        {toggle}
      </div>
      <SearchResultSection
        id="search-library"
        title="In your library"
        source="Downloaded videos that match"
        count={videos.length}
        emptyText="Nothing in your library matches."
      >
        <LibraryGrid videos={videos} searchQuery={query} options={grid} />
      </SearchResultSection>
      {saidOn && (
        <SearchResultSection
          id="search-said"
          title="Said in videos"
          source="Captions of indexed channels"
          count={saidGroups.length}
          emptyText="Nothing in the indexed captions mentions that."
          loading={said.isLoading}
        >
          <SaidInVideos groups={saidGroups} search={said} />
        </SearchResultSection>
      )}
      <SearchResultSection
        id="search-stream"
        title="Available to stream"
        source="From channels Horde has indexed"
        count={global.streamResults.length}
        emptyText="No matches in indexed channels."
        loading={global.streamLoading}
      >
        <RemoteEntryGrid
          entries={global.streamResults}
          searchQuery={query}
          global={global}
          onChannelClick={onChannelClick}
          sidebarCollapsed={sidebarCollapsed}
        />
      </SearchResultSection>
      {youtubeOn && (
        <SearchResultSection
          id="search-youtube"
          title="On YouTube"
          source="Live search, not yet downloaded"
          count={global.youtubeVisible.length}
          emptyText="No other matches on YouTube."
          loading={youtubePending}
          footer={
            global.youtubeHasMore ? (
              <div className="flex justify-center">
                <button
                  type="button"
                  className={button("secondary")}
                  disabled={global.youtubeLoadingMore}
                  onClick={() => global.loadMoreYoutube()}
                >
                  {global.youtubeLoadingMore
                    ? "Loading…"
                    : YOUTUBE_SEARCH_LOAD_MORE_LABEL}
                </button>
              </div>
            ) : null
          }
        >
          <RemoteEntryGrid
            entries={global.youtubeVisible}
            searchQuery={global.youtubeQuery || query}
            global={global}
            onChannelClick={onChannelClick}
            sidebarCollapsed={sidebarCollapsed}
          />
        </SearchResultSection>
      )}
      <SearchResultSection
        id="search-other"
        title="Rest of your library"
        source="Everything else, not matching"
        count={otherVideos.length}
        emptyText="No other videos in your library."
      >
        <LibraryGrid
          videos={otherVideos}
          indexOffset={videos.length}
          searchQuery={query}
          options={grid}
        />
      </SearchResultSection>
    </div>
  );
}
