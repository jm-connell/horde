import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type { RecTuningWrite } from "../types";
import { queryKeys } from "./keys";

/** The signed-in user's Recommended+ algorithm: a preset or their own values. */
export function useRecTuning() {
  return useQuery({
    queryKey: queryKeys.discover.tuning,
    queryFn: ({ signal }) => api.getRecTuning({ signal }),
    staleTime: 60_000,
  });
}

/** Save the algorithm; the feed re-ranks when the cached settings change. */
export function useSaveRecTuning() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: RecTuningWrite) => api.saveRecTuning(payload),
    onSuccess: (state) =>
      queryClient.setQueryData(queryKeys.discover.tuning, state),
  });
}
