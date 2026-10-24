import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { api } from "../api";
import { queryKeys } from "./keys";

/** Polling knobs a screen passes; `false` turns the interval off. */
export interface PollOptions {
  /** Milliseconds between refetches while the tab is visible. */
  interval?: number | false;
  enabled?: boolean;
}

/**
 * Status data is cheap, changes on its own and is read by several screens at
 * once. One query key per resource means those screens share a single request
 * (the shortest interval among the mounted observers wins) and a screen that
 * mounts later paints the cached value immediately while it refetches.
 */
const STATUS_STALE_MS = 2_000;

function statusOptions({ interval = false, enabled = true }: PollOptions) {
  return {
    enabled,
    refetchInterval: interval,
    refetchOnWindowFocus: true,
    staleTime: STATUS_STALE_MS,
  } as const;
}

/**
 * The value a screen shows: `null` while loading or after a failed fetch (the
 * panels these feed hide themselves then), instead of the last good value.
 */
export function dataOrNull<T>(q: UseQueryResult<T>): T | null {
  return q.isError ? null : (q.data ?? null);
}

/** Query definition, also used with `queryClient.fetchQuery` to force a read. */
export const aiStatusQuery = () => ({
  queryKey: queryKeys.ai.status,
  queryFn: ({ signal }: { signal: AbortSignal }) => api.getAiStatus({ signal }),
});

export function useAiStatus(opts: PollOptions = {}) {
  return useQuery({
    ...aiStatusQuery(),
    ...statusOptions(opts),
  });
}

export function useSystemStats(opts: PollOptions = {}) {
  return useQuery({
    queryKey: queryKeys.system.stats,
    queryFn: ({ signal }) => api.getSystemStats({ signal }),
    ...statusOptions(opts),
  });
}

/** Disk used by the library (and the trash); refreshed after deletes and restores. */
export function useStorageStats() {
  return useQuery({
    queryKey: queryKeys.system.storage,
    queryFn: ({ signal }) => api.storageStats({ signal }),
    staleTime: 0,
  });
}

export function useSystemActivity(opts: PollOptions = {}) {
  return useQuery({
    queryKey: queryKeys.system.activity,
    queryFn: ({ signal }) => api.getSystemActivity({ signal }),
    ...statusOptions(opts),
  });
}

/** Polls every 3 s while H.264 jobs are queued or running, then stops. */
export function useCompatSummary() {
  return useQuery({
    queryKey: queryKeys.compat.summary,
    queryFn: ({ signal }) => api.getCompatSummary({ signal }),
    ...statusOptions({}),
    refetchInterval: (query) => {
      const s = query.state.data;
      return s &&
        s.queued + s.running + s.convert_queued + s.convert_running > 0
        ? 3000
        : false;
    },
  });
}

/** Query definition, also used with `queryClient.fetchQuery` to force a read. */
export const channelCatalogStatusQuery = () => ({
  queryKey: queryKeys.channels.catalogStatus,
  queryFn: ({ signal }: { signal: AbortSignal }) =>
    api.getChannelCatalogStatus({ signal }),
});

export function useChannelCatalogStatus(opts: PollOptions = {}) {
  return useQuery({
    ...channelCatalogStatusQuery(),
    ...statusOptions(opts),
  });
}

/** Query definition, also used with `queryClient.fetchQuery` to force a read. */
export const metadataSyncStatusQuery = () => ({
  queryKey: queryKeys.metadata.syncStatus,
  queryFn: ({ signal }: { signal: AbortSignal }) =>
    api.getMetadataSyncStatus({ signal }),
});

export function useMetadataSyncStatus(opts: PollOptions = {}) {
  return useQuery({
    ...metadataSyncStatusQuery(),
    ...statusOptions(opts),
  });
}

export function useOpenRouterCosts(opts: PollOptions = {}) {
  return useQuery({
    queryKey: queryKeys.ai.costs,
    queryFn: ({ signal }) => api.getOpenRouterCosts({ signal }),
    ...statusOptions(opts),
  });
}

/** The OpenRouter model catalog; changes rarely, so it stays fresh for minutes. */
export function useOpenRouterModels(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.ai.models,
    queryFn: ({ signal }) => api.getOpenRouterModels({ signal }),
    enabled,
    staleTime: 5 * 60_000,
  });
}

export function useReviewCount(opts: PollOptions = {}) {
  return useQuery({
    queryKey: queryKeys.review.count,
    queryFn: ({ signal }) => api.reviewCount({ signal }),
    ...statusOptions(opts),
  });
}
