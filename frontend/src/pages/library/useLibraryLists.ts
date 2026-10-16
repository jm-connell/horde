import { useMemo } from "react";
import {
  useChannels,
  useTagStats,
  useVideoList,
  type VideoFilters,
} from "../../queries/videos";
import type { ChannelStat, TagStat, Video } from "../../types";
import type { Settings } from "../../hooks/useSettings";

const NO_VIDEOS: Video[] = [];
const NO_CHANNELS: ChannelStat[] = [];
const NO_TAGS: TagStat[] = [];

/**
 * The lists on the library page. Each is a query (see queries/videos): a cached
 * answer paints at once, then revalidates in the background.
 */
export function useLibraryLists(input: {
  mainFilters: VideoFilters;
  debouncedSearch: string;
  activeChannel: string | null;
  /** The Recommended tab renders its own data; skip the full-library fetches. */
  skipLibrary: boolean;
  channelSort: Settings["channelSort"];
  channelOrder: Settings["channelOrder"];
}) {
  const { mainFilters, debouncedSearch, skipLibrary } = input;
  const matchList = useVideoList(mainFilters, !skipLibrary);
  const videos = matchList.videos;
  // With a search, the rest of the library follows the matches.
  const restList = useVideoList(
    { ...mainFilters, q: undefined },
    !skipLibrary && !!debouncedSearch
  );
  const otherVideos = useMemo(() => {
    if (!debouncedSearch) return NO_VIDEOS;
    const matchIds = new Set(videos.map((v) => v.id));
    return restList.videos.filter((v) => !matchIds.has(v.id));
  }, [debouncedSearch, videos, restList.videos]);
  const continueWatching = useVideoList(
    { continue_watching: true },
    !skipLibrary
  ).videos;
  const channels =
    useChannels(input.channelSort, input.channelOrder).data ?? NO_CHANNELS;
  const tags =
    useTagStats(input.activeChannel || undefined, !skipLibrary).data ?? NO_TAGS;

  return {
    videos,
    loading: matchList.loading,
    otherVideos,
    continueWatching,
    channels,
    tags,
  };
}
