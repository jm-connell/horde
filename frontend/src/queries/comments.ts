import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { queryKeys } from "./keys";

/** The comments saved with a library video. */
export function useVideoComments(videoId: number | null) {
  return useQuery({
    queryKey: queryKeys.comments.video(videoId ?? 0),
    queryFn: ({ signal }) => api.videoComments(videoId ?? 0, { signal }),
    enabled: videoId !== null,
  });
}

/**
 * The top `limit` comments read from YouTube (not saved). Off until `limit`
 * is set; a larger `limit` keeps showing the previous list while it loads.
 */
export function useLiveComments(
  youtubeId: string | null,
  limit: number | null
) {
  return useQuery({
    queryKey: queryKeys.comments.live(youtubeId ?? "", limit ?? 0),
    queryFn: ({ signal }) =>
      api.liveComments(youtubeId ?? "", limit ?? 0, { signal }),
    enabled: youtubeId !== null && limit !== null,
    placeholderData: keepPreviousData,
    // Read from YouTube, so never refetched behind the user's back.
    staleTime: Infinity,
    retry: false,
  });
}
