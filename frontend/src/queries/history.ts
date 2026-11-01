import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { api } from "../api";
import { useSettings } from "../hooks/useSettings";
import type { HistoryStatsRange } from "../types";
import { queryKeys } from "./keys";

/**
 * The signed-in account's watch stats for `range`. Refetched whenever History
 * opens (watching elsewhere changes them); a range switch keeps showing the
 * previous range until the new one arrives. Counts the imported YouTube
 * history when the account chose to (`historyIncludeYoutube`).
 */
export function useHistoryStats(range: HistoryStatsRange, enabled = true) {
  const [settings] = useSettings();
  const includeYoutube = settings.historyIncludeYoutube;
  return useQuery({
    queryKey: queryKeys.history.stats(range, includeYoutube),
    queryFn: ({ signal }) =>
      api.historyStats(range, { signal, includeYoutube }),
    placeholderData: keepPreviousData,
    staleTime: 0,
    enabled,
  });
}

const WATCH_PAGE = 48;

/** Everything the account watched (library, streamed, imported), a page at a time. */
export function useHistoryWatches() {
  return useInfiniteQuery({
    queryKey: queryKeys.history.watches,
    queryFn: ({ pageParam, signal }) =>
      api.historyWatches({ cursor: pageParam, limit: WATCH_PAGE }, { signal }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor ?? null,
    staleTime: 0,
  });
}

/** After a removal or a taste change: the history, its stats and the feeds. */
function useInvalidateHistory() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.history.all }),
      queryClient.invalidateQueries({ queryKey: queryKeys.videos.all }),
      queryClient.invalidateQueries({ queryKey: queryKeys.takeout.all }),
    ]);
}

export function useRemoveHistory() {
  const invalidate = useInvalidateHistory();
  return useMutation({
    mutationFn: (keys: string[]) => api.removeHistory(keys),
    onSuccess: invalidate,
  });
}

export function useSetHistoryTaste() {
  const invalidate = useInvalidateHistory();
  return useMutation({
    mutationFn: ({ keys, use }: { keys: string[]; use: boolean }) =>
      api.setHistoryTaste(keys, use),
    onSuccess: invalidate,
  });
}

/** Imported YouTube views of the last few days, for Continue watching. */
export function useContinueYoutube(enabled = true) {
  return useQuery({
    queryKey: queryKeys.history.continueYoutube,
    queryFn: ({ signal }) => api.continueYoutube({ signal }),
    enabled,
  });
}
