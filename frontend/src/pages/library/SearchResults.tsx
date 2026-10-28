import { useId, useState, type ReactNode } from "react";
import ChannelFeedCard from "../../components/ChannelFeedCard";
import type { ChannelFeedEntry, Video } from "../../types";
import { YOUTUBE_SEARCH_LOAD_MORE_LABEL } from "../libraryCatalogProgress";
import { useSearch } from "../../context/SearchContext";
import LibraryGrid, { type LibraryGridOptions } from "./LibraryGrid";
import { videoGridClassName } from "./videoGridClassName";
import type { useGlobalSearch } from "./useGlobalSearch";
import { ChevronIcon } from "../../components/icons";

function SearchResultSection({
  id,
  title,
  source,
  count,
  emptyText,
  loading = false,
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
  footer?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(true);
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

/** A home-page search: the library matches, then everything else worth showing. */
export default function SearchResults({
  query,
  videos,
  otherVideos,
  global,
  grid,
  onChannelClick,
}: {
  query: string;
  videos: Video[];
  otherVideos: Video[];
  global: ReturnType<typeof useGlobalSearch>;
  grid: LibraryGridOptions;
  onChannelClick: (hit: { name: string; url: string | null }) => void;
}) {
  const { sidebarCollapsed } = grid;
  const { youtubeVideoSearch } = useSearch();
  // YouTube is searched a moment after typing stops and takes a second or two:
  // show its heading from the start, marked as searching.
  const youtubeOn = youtubeVideoSearch && query.trim().length >= 2;
  const youtubePending =
    youtubeOn &&
    (global.youtubeLoading || global.youtubeQuery.trim() !== query.trim());
  return (
    <div className="space-y-8">
      <SectionStrip
        items={[
          {
            id: "search-library",
            label: "In your library",
            count: videos.length,
          },
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
      <SearchResultSection
        id="search-library"
        title="In your library"
        source="Downloaded videos that match"
        count={videos.length}
        emptyText="Nothing in your library matches."
      >
        <LibraryGrid videos={videos} searchQuery={query} options={grid} />
      </SearchResultSection>
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
                  className="ui-panel ui-interactive rounded-lg border border-ink-700 bg-ink-900 px-4 py-2 text-sm text-gray-200 hover:border-accent disabled:cursor-not-allowed disabled:opacity-50"
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
