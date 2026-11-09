import { useCallback, useMemo } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { api } from "../api";
import type { ChannelFeedEntry } from "../types";
import { queryKeys } from "./keys";

/** The AI results saved for a streamed video (summary, chapters, expiry). */
export const streamAiQuery = (url: string, enabled = true) => ({
  queryKey: queryKeys.preview.ai(url),
  queryFn: ({ signal }: { signal: AbortSignal }) =>
    api.getStreamAi(url, { signal }),
  enabled: enabled && !!url,
  staleTime: 30_000,
});

export function useStreamAi(url: string, enabled: boolean) {
  return useQuery(streamAiQuery(url, enabled));
}

/** The game a YouTube Gaming video is about (null when none or not Gaming). */
export function useStreamGame(url: string | undefined, gaming: boolean) {
  const query = useQuery({
    queryKey: queryKeys.preview.game(url ?? ""),
    queryFn: ({ signal }) => api.getStreamGame(url ?? "", { signal }),
    enabled: !!url && gaming,
    staleTime: Infinity,
    retry: false,
  });
  return query.data?.game ?? null;
}

/**
 * Related videos for a stream: library and not-downloaded ones, marked, woven
 * with YouTube's up next. Paged: `loadMore` asks for the next page.
 */
export function useStreamRelated(url: string | undefined) {
  const query = useInfiniteQuery({
    queryKey: queryKeys.preview.related(url ?? ""),
    queryFn: ({ pageParam, signal }) =>
      api.getStreamRelated(url ?? "", 24, { signal }, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    enabled: !!url,
    staleTime: 5 * 60_000,
  });
  const items = useMemo<ChannelFeedEntry[]>(
    () => (query.data?.pages ?? []).flatMap((p) => p.items),
    [query.data]
  );
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);
  return {
    items,
    loading: query.isLoading,
    hasMore: Boolean(hasNextPage),
    loadingMore: isFetchingNextPage,
    loadMore,
  };
}
