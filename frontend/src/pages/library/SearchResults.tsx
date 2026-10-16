import { useId, useState, type ReactNode } from "react";
import ChannelFeedCard from "../../components/ChannelFeedCard";
import LoadingIndicator from "../../components/LoadingIndicator";
import type { ChannelFeedEntry, Video } from "../../types";
import {
  YOUTUBE_SEARCH_LOADING_LABEL,
  YOUTUBE_SEARCH_LOAD_MORE_LABEL,
} from "../libraryCatalogProgress";
import LibraryGrid, { type LibraryGridOptions } from "./LibraryGrid";
import { videoGridClassName } from "./videoGridClassName";
import type { useGlobalSearch } from "./useGlobalSearch";

function SearchResultSection({
  title,
  count,
  emptyText,
  loading = false,
  footer,
  children,
}: {
  title: string;
  count: number;
  emptyText: string;
  loading?: boolean;
  footer?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  const bodyId = useId();
  return (
    <section className="space-y-4">
      <div className="flex items-center gap-3">
        <hr className="min-w-0 flex-1 border-0 border-t border-ink-700" />
        <button
          type="button"
          className="ui-interactive inline-flex shrink-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-xs font-medium text-gray-400"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((v) => !v)}
        >
          <span
            className={`inline-block text-[0.65rem] leading-none text-muted transition-transform ${
              open ? "" : "-rotate-90"
            }`}
            aria-hidden
          >
            ▼
          </span>
          <span>
            {title}
            {!loading && <span className="ml-1.5 text-muted">({count})</span>}
          </span>
        </button>
        <hr className="min-w-0 flex-1 border-0 border-t border-ink-700" />
      </div>
      <div id={bodyId} hidden={!open} className="space-y-4">
        {loading ? (
          <LoadingIndicator className="py-8" />
        ) : count > 0 ? (
          <>
            {children}
            {footer}
          </>
        ) : (
          <p className="py-6 text-center text-sm text-muted" role="status">
            {emptyText}
          </p>
        )}
      </div>
    </section>
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
  return (
    <div className="space-y-6">
      <SearchResultSection
        title="In your library"
        count={videos.length}
        emptyText="No matching videos found in library"
      >
        <LibraryGrid videos={videos} searchQuery={query} options={grid} />
      </SearchResultSection>
      <SearchResultSection
        title="Available to stream"
        count={global.streamResults.length}
        emptyText="No matching videos from indexed channels"
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
      {global.youtubeLoading && global.youtubeVisible.length === 0 && (
        <p className="text-center text-xs text-muted" role="status">
          {YOUTUBE_SEARCH_LOADING_LABEL}
        </p>
      )}
      {global.youtubeVisible.length > 0 && (
        <SearchResultSection
          title="On YouTube"
          count={global.youtubeVisible.length}
          emptyText=""
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
        title="Other videos in library"
        count={otherVideos.length}
        emptyText="No other videos in library"
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
