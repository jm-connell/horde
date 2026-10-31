import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
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

/** Fetch and save a library video's comments now; the saved list updates. */
export function useRefreshVideoComments(videoId: number | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.refreshVideoComments(videoId ?? 0),
    onSuccess: (data) =>
      qc.setQueryData(queryKeys.comments.video(videoId ?? 0), data),
  });
}

/**
 * Comments read from YouTube (not saved), one query per step the reader asked
 * for (`limits`, e.g. 300 then 1000). Only the last step fetches; earlier ones
 * stay readable from the cache, so a failed step keeps what was already shown.
 */
export function useLiveCommentSteps(
  youtubeId: string | null,
  limits: number[]
) {
  return useQueries({
    queries: limits.map((limit, i) => ({
      queryKey: queryKeys.comments.live(youtubeId ?? "", limit),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        api.liveComments(youtubeId ?? "", limit, { signal }),
      enabled: youtubeId !== null && i === limits.length - 1,
      // Read from YouTube, so never refetched behind the reader's back, and
      // kept as long as the server keeps it.
      staleTime: Infinity,
      gcTime: 30 * 60_000,
      retry: false,
    })),
  });
}
