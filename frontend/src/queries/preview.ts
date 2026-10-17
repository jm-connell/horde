import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
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

/** Related videos for a stream: library and not-downloaded ones, marked. */
export function useStreamRelated(url: string | undefined) {
  const query = useQuery({
    queryKey: queryKeys.preview.related(url ?? ""),
    queryFn: ({ signal }) => api.getStreamRelated(url ?? "", 24, { signal }),
    enabled: !!url,
    staleTime: 5 * 60_000,
  });
  const items = useMemo<ChannelFeedEntry[]>(
    () => query.data?.items ?? [],
    [query.data]
  );
  return { items, loading: query.isLoading };
}
