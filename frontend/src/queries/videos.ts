import { useEffect, useMemo } from "react";
import {
  infiniteQueryOptions,
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
  type InfiniteData,
  type QueryClient,
} from "@tanstack/react-query";
import { PAGE_SIZE, api, type LibraryQuery, type Page } from "../api";
import type { Video } from "../types";
import { queryKeys } from "./keys";

/** What selects a list of videos; part of the query key. */
export type VideoFilters = Omit<LibraryQuery, "signal">;

const NO_VIDEOS: Video[] = [];

/**
 * A video list over the cursor API. Every page is a request of its own, so a
 * failure part-way leaves the pages already loaded in place, and a refetch
 * replaces the list only once all of its pages have arrived (no flicker).
 *
 * `staleTime: 0`: a list is shown from the cache at once but always revalidated
 * on mount, so edits made on another page show up.
 */
export const videoListOptions = (filters: VideoFilters) =>
  infiniteQueryOptions({
    queryKey: queryKeys.videos.list(filters),
    queryFn: ({ pageParam, signal }) =>
      api.listVideosPage({
        ...filters,
        limit: PAGE_SIZE,
        cursor: pageParam,
        signal,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last: Page<Video>) => last.next_cursor ?? undefined,
    staleTime: 0,
    gcTime: 30 * 60_000,
  });

export interface VideoList {
  videos: Video[];
  /** Nothing to show yet and a request is in flight. */
  loading: boolean;
  /** Pages after the first failed to load; `videos` holds what did load. */
  partial: boolean;
}

/**
 * Load a whole list, first page first: the screen paints page one and the rest
 * streams in behind it. The previous list stays up while a new filter loads.
 */
export function useVideoList(filters: VideoFilters, enabled = true): VideoList {
  const query = useInfiniteQuery({
    ...videoListOptions(filters),
    enabled,
    placeholderData: keepPreviousData,
  });
  const { hasNextPage, isFetching, isFetchNextPageError, fetchNextPage } =
    query;
  useEffect(() => {
    if (enabled && hasNextPage && !isFetching && !isFetchNextPageError) {
      void fetchNextPage();
    }
  }, [enabled, hasNextPage, isFetching, isFetchNextPageError, fetchNextPage]);

  const videos = useMemo(
    () => query.data?.pages.flatMap((p) => p.items) ?? NO_VIDEOS,
    [query.data]
  );
  return {
    videos,
    loading: enabled && query.isPending,
    partial: isFetchNextPageError,
  };
}

/** Change a video wherever the cached lists hold it (rows that match a filter stay). */
export function replaceVideoInLists(
  queryClient: QueryClient,
  video: Video
): void {
  queryClient.setQueriesData<InfiniteData<Page<Video>, string | null>>(
    { queryKey: queryKeys.videos.lists },
    (data) =>
      data && {
        ...data,
        pages: data.pages.map((page) =>
          page.items.some((v) => v.id === video.id)
            ? {
                ...page,
                items: page.items.map((v) => (v.id === video.id ? video : v)),
              }
            : page
        ),
      }
  );
}

/** Put a freshly finished video at the top of one list. */
export function prependVideoToList(
  queryClient: QueryClient,
  filters: VideoFilters,
  video: Video
): void {
  queryClient.setQueryData<InfiniteData<Page<Video>, string | null>>(
    queryKeys.videos.list(filters),
    (data) => {
      if (!data || data.pages.length === 0) return data;
      if (data.pages.some((p) => p.items.some((v) => v.id === video.id))) {
        return data;
      }
      const [first, ...rest] = data.pages;
      return {
        ...data,
        pages: [{ ...first, items: [video, ...first.items] }, ...rest],
      };
    }
  );
}

export function useChannels(
  sort: string | undefined,
  order: string | undefined
) {
  return useQuery({
    queryKey: queryKeys.channels.list(sort, order),
    queryFn: ({ signal }) => api.listChannels({ sort, order, signal }),
    staleTime: 0,
    placeholderData: keepPreviousData,
  });
}

export function useTagStats(channel: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.tags.stats(channel),
    queryFn: ({ signal }) => api.tagStats(channel, { signal }),
    enabled,
    staleTime: 0,
    placeholderData: keepPreviousData,
  });
}
