import VideoCard from "../../components/VideoCard";
import { videoGridClassName } from "./videoGridClassName";
import type { Video } from "../../types";

function videoProgress(video: Video): number | undefined {
  if (!video.duration_sec || video.duration_sec <= 0) return undefined;
  if (video.last_position_sec <= 0) return undefined;
  return Math.min(1, video.last_position_sec / video.duration_sec);
}

/** What every grid of library cards on the page shares. */
export interface LibraryGridOptions {
  sidebarCollapsed: boolean;
  showViewCount: boolean;
  showProgress: boolean;
  selectMode: boolean;
  selectedIds: ReadonlySet<number>;
  onToggle: (id: number, index: number, shift: boolean) => void;
}

/**
 * The cards of a list of library videos. Every card is in the DOM: the library
 * is a normal page-scrolling list so keyboard Tab order, find-in-page and
 * screen-reader navigation reach all of it.
 */
export default function LibraryGrid({
  videos,
  indexOffset = 0,
  searchQuery,
  options,
}: {
  videos: Video[];
  /** Position of the first card among all selectable cards on the page. */
  indexOffset?: number;
  searchQuery: string;
  options: LibraryGridOptions;
}) {
  return (
    <div className={videoGridClassName(options.sidebarCollapsed)}>
      {videos.map((v, idx) => (
        <VideoCard
          key={v.id}
          video={v}
          layout="feed"
          searchQuery={searchQuery}
          showViewCount={options.showViewCount}
          progress={options.showProgress ? videoProgress(v) : undefined}
          selectable={options.selectMode}
          selected={options.selectedIds.has(v.id)}
          onSelect={(id, e) =>
            options.onToggle(id, indexOffset + idx, e.shiftKey)
          }
        />
      ))}
    </div>
  );
}
