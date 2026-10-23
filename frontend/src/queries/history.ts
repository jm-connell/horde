import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api } from "../api";
import type { HistoryStatsRange } from "../types";
import { queryKeys } from "./keys";

/**
 * The signed-in account's watch stats for `range`. Refetched whenever History
 * opens (watching elsewhere changes them); a range switch keeps showing the
 * previous range until the new one arrives.
 */
export function useHistoryStats(range: HistoryStatsRange, enabled = true) {
  return useQuery({
    queryKey: queryKeys.history.stats(range),
    queryFn: ({ signal }) => api.historyStats(range, { signal }),
    placeholderData: keepPreviousData,
    staleTime: 0,
    enabled,
  });
}
