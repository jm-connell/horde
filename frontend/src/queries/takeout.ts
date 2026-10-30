import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { api } from "../api";
import type { TakeoutApplyRequest } from "../types";
import { queryKeys } from "./keys";

/** The signed-in account's imported YouTube history, summed up. */
export function useTakeoutHistory(enabled = true) {
  return useQuery({
    queryKey: queryKeys.takeout.history,
    queryFn: ({ signal }) => api.takeoutHistory({ signal }),
    enabled,
  });
}

/** Everything an import or a clear changes: the history and what reads it. */
function useInvalidateTakeout() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.takeout.all }),
      queryClient.invalidateQueries({ queryKey: queryKeys.history.all }),
    ]);
}

export function useImportTakeout() {
  const invalidate = useInvalidateTakeout();
  return useMutation({
    mutationFn: ({
      files,
      onProgress,
    }: {
      files: File[];
      onProgress?: (pct: number) => void;
    }) => api.importTakeout(files, onProgress),
    onSuccess: invalidate,
  });
}

export function useApplyTakeout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (choice: TakeoutApplyRequest) => api.applyTakeout(choice),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.follows.list }),
        queryClient.invalidateQueries({ queryKey: queryKeys.live.now }),
        queryClient.invalidateQueries({ queryKey: queryKeys.playlists.all }),
      ]),
  });
}

export function useClearTakeout() {
  const invalidate = useInvalidateTakeout();
  return useMutation({
    mutationFn: () => api.clearTakeoutHistory(),
    onSuccess: invalidate,
  });
}

/** Videos watched several times on YouTube that are not downloaded, page by page. */
export function useRewatched(enabled = true) {
  return useInfiniteQuery({
    queryKey: queryKeys.takeout.rewatched,
    queryFn: ({ pageParam, signal }) =>
      api.rewatched(pageParam, 12, { signal }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor,
    enabled,
  });
}
