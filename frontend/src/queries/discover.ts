import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type {
  RecAlgorithmUpdate,
  RecAlgorithmWrite,
  RecTopicUpdate,
  RecTopicWrite,
  RecTuningWrite,
} from "../types";
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

/** The user's typed-in interests and blocked topics. */
export function useRecTopics() {
  return useQuery({
    queryKey: queryKeys.discover.topics,
    queryFn: ({ signal }) => api.listRecTopics({ signal }),
    staleTime: 60_000,
  });
}

function useInvalidateTopics() {
  const queryClient = useQueryClient();
  return () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.discover.topics });
}

export function useAddRecTopic() {
  const invalidate = useInvalidateTopics();
  return useMutation({
    mutationFn: (payload: RecTopicWrite) => api.addRecTopic(payload),
    onSuccess: invalidate,
  });
}

export function useUpdateRecTopic() {
  const invalidate = useInvalidateTopics();
  return useMutation({
    mutationFn: ({ id, payload }: { id: number; payload: RecTopicUpdate }) =>
      api.updateRecTopic(id, payload),
    onSuccess: invalidate,
  });
}

export function useDeleteRecTopic() {
  const invalidate = useInvalidateTopics();
  return useMutation({
    mutationFn: (id: number) => api.deleteRecTopic(id),
    onSuccess: invalidate,
  });
}

/** Your saved algorithms, then the ones other accounts share. */
export function useRecAlgorithms() {
  return useQuery({
    queryKey: queryKeys.discover.algorithms,
    queryFn: ({ signal }) => api.listRecAlgorithms({ signal }),
    staleTime: 60_000,
  });
}

/** After saving, sharing or deleting: the list and what you rank with. */
function useInvalidateAlgorithms() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.discover.algorithms }),
      queryClient.invalidateQueries({ queryKey: queryKeys.discover.tuning }),
    ]);
}

export function useSaveRecAlgorithm() {
  const invalidate = useInvalidateAlgorithms();
  return useMutation({
    mutationFn: (payload: RecAlgorithmWrite) => api.saveRecAlgorithm(payload),
    onSuccess: invalidate,
  });
}

export function useUpdateRecAlgorithm() {
  const invalidate = useInvalidateAlgorithms();
  return useMutation({
    mutationFn: ({ id, payload }: { id: number; payload: RecAlgorithmUpdate }) =>
      api.updateRecAlgorithm(id, payload),
    onSuccess: invalidate,
  });
}

export function useDeleteRecAlgorithm() {
  const invalidate = useInvalidateAlgorithms();
  return useMutation({
    mutationFn: (id: number) => api.deleteRecAlgorithm(id),
    onSuccess: invalidate,
  });
}
