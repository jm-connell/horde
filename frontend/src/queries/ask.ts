import { useMemo } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { api, type Page } from "../api";
import type { AskChannel, AskSearchHit } from "../types";
import { queryKeys } from "./keys";

/** Passages per page of transcript search. */
export const ASK_SEARCH_PAGE_SIZE = 30;
const NO_HITS: AskSearchHit[] = [];
const BUSY = new Set(["queued", "listing", "indexing"]);

/** True while Horde is still listing or fetching captions for the channel. */
export function isAskChannelBusy(channel: AskChannel): boolean {
  return BUSY.has(channel.status);
}

/** Ask channels with their progress; refreshes every few seconds while indexing. */
export function useAskChannels(enabled = true) {
  return useQuery({
    queryKey: queryKeys.ask.channels,
    queryFn: ({ signal }) => api.askChannels({ signal }),
    enabled,
    refetchInterval: (query) =>
      query.state.data?.items.some(isAskChannelBusy) ? 5000 : false,
  });
}

/** Add, change, pause, resume and remove channels; each refreshes the list. */
export function useAskChannelActions() {
  const qc = useQueryClient();
  const onSuccess = () =>
    qc.invalidateQueries({ queryKey: queryKeys.ask.channels });
  const add = useMutation({
    mutationFn: (v: { url: string; includeStreams: boolean }) =>
      api.addAskChannel(v.url, v.includeStreams),
    onSuccess,
  });
  const setStreams = useMutation({
    mutationFn: (v: { id: number; includeStreams: boolean }) =>
      api.setAskChannelStreams(v.id, v.includeStreams),
    onSuccess,
  });
  const pause = useMutation({
    mutationFn: (id: number) => api.pauseAskChannel(id),
    onSuccess,
  });
  const resume = useMutation({
    mutationFn: (id: number) => api.resumeAskChannel(id),
    onSuccess,
  });
  const remove = useMutation({
    mutationFn: (id: number) => api.removeAskChannel(id),
    onSuccess,
  });
  return { add, setStreams, pause, resume, remove };
}

/** Transcript search across the given channels (all when empty). */
export function useAskSearch(q: string, channelIds: number[]) {
  const query = useInfiniteQuery({
    queryKey: queryKeys.ask.search(q, channelIds),
    queryFn: ({ pageParam, signal }) =>
      api.searchAsk({
        q,
        channelIds,
        cursor: pageParam,
        limit: ASK_SEARCH_PAGE_SIZE,
        signal,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last: Page<AskSearchHit>) =>
      last.next_cursor ?? undefined,
    enabled: q.trim().length > 0,
  });
  const hits = useMemo(
    () => query.data?.pages.flatMap((p) => p.items) ?? NO_HITS,
    [query.data]
  );
  return { ...query, hits };
}
