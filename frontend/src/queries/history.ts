import { keepPreviousData, useQuery } from "@tanstack/react-query";
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
