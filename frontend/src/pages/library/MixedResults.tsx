import { Link } from "react-router-dom";
import ChannelFeedCard from "../../components/ChannelFeedCard";
import VideoCard from "../../components/VideoCard";
import type { AskSearchHit, Video } from "../../types";
import { formatTimestamp } from "../../utils";
import { askWatchPath } from "../ask/askLinks";
import type { LibraryGridOptions } from "./LibraryGrid";
import type { MixedItem } from "./mixResults";
import { Snippet } from "./SaidInVideos";
import SearchPlaceholderCard from "./SearchPlaceholderCard";
import type { useGlobalSearch } from "./useGlobalSearch";
import { videoGridClassName } from "./videoGridClassName";

/** Cards shown while the library, catalogs and captions are searched. */
const LOADING_CARDS = 8;

function videoProgress(video: Video): number | undefined {
  if (!video.duration_sec || video.duration_sec <= 0) return undefined;
  if (video.last_position_sec <= 0) return undefined;
  return Math.min(1, video.last_position_sec / video.duration_sec);
}

/** Up to two moments where the video says the words, each a link to it. */
function Moments({
  moments,
  libraryVideoId,
}: {
  moments: AskSearchHit[];
  libraryVideoId: number | null;
}) {
  if (!moments.length) return null;
  return (
    <ul className="space-y-1 px-3 pb-3 pt-2 sm:px-1">
      {moments.slice(0, 2).map((hit) => (
        <li
          key={`${hit.start_sec}-${hit.in_description}`}
          className="line-clamp-2 text-xs text-gray-400"
        >
          <Link
            to={askWatchPath({
              ...hit,
              library_video_id: libraryVideoId ?? hit.library_video_id,
            })}
            className="mr-1.5 font-mono text-accent hover:underline"
          >
            {hit.in_description
              ? "Description"
              : formatTimestamp(hit.start_sec)}
          </Link>
          <Snippet text={hit.snippet} />
        </li>
      ))}
    </ul>
  );
}

/**
 * Every source's results in one grid, best first. Library cards can be
 * selected like the library's own; others can be streamed or downloaded.
 */
export default function MixedResults({
  items,
  loading,
  query,
  grid,
  global,
  selectIndex,
  onChannelClick,
}: {
  items: MixedItem[];
  /** The library, catalogs and captions are still being searched. */
  loading: boolean;
  query: string;
  grid: LibraryGridOptions;
  global: ReturnType<typeof useGlobalSearch>;
  /** Each library video's place among the page's selectable cards. */
  selectIndex: ReadonlyMap<number, number>;
  onChannelClick: (hit: { name: string; url: string | null }) => void;
}) {
  if (loading) {
    return (
      <div className={videoGridClassName(grid.sidebarCollapsed)}>
        {Array.from({ length: LOADING_CARDS }, (_, i) => (
          <SearchPlaceholderCard key={i} label="Searching…" />
        ))}
      </div>
    );
  }
  if (!items.length) {
    return (
      <p className="py-2 text-sm text-muted" role="status">
        Nothing matches.
      </p>
    );
  }
  return (
    <div className={videoGridClassName(grid.sidebarCollapsed)}>
      {items.map((item) => (
        <div key={item.key} className="flex flex-col">
          {item.kind === "slot" ? (
            <SearchPlaceholderCard />
          ) : item.kind === "library" ? (
            <>
              <div className="flex-1">
                <VideoCard
                  video={item.video}
                  layout="feed"
                  searchQuery={query}
                  showViewCount={grid.showViewCount}
                  progress={
                    grid.showProgress ? videoProgress(item.video) : undefined
                  }
                  selectable={grid.selectMode}
                  selected={grid.selectedIds.has(item.video.id)}
                  onSelect={(id, e) =>
                    grid.onToggle(id, selectIndex.get(id) ?? 0, e.shiftKey)
                  }
                />
              </div>
              <Moments moments={item.moments} libraryVideoId={item.video.id} />
            </>
          ) : (
            <>
              <div className="flex-1">
                <ChannelFeedCard
                  entry={item.entry}
                  channelName={item.entry.channel || "Unknown channel"}
                  layout="grid"
                  inLibrary={false}
                  searchQuery={query}
                  onDownload={() => global.queueRemoteDownload(item.entry)}
                  downloading={global.streamDownloading.has(item.entry.url)}
                  skipRemotePreview
                  onChannelClick={onChannelClick}
                />
              </div>
              <Moments moments={item.moments} libraryVideoId={null} />
            </>
          )}
        </div>
      ))}
    </div>
  );
}
