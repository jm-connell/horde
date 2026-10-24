import { useCallback, useMemo } from "react";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { ApiError, api, type Page } from "../api";
import { describeError } from "../apiErrors";
import { useAuth } from "../context/AuthContext";
import { useToast } from "../context/ToastContext";
import type { TrashItem } from "../types";
import { queryKeys } from "./keys";

/** Rows per "Show more" in the settings list. */
export const TRASH_PAGE_SIZE = 20;

const NO_ITEMS: TrashItem[] = [];

/**
 * Count, size and retention of the trash. Needs `delete_videos`, so it only
 * loads for someone who may delete (everyone else never sees a delete button).
 */
export function useTrashSummary() {
  const { can } = useAuth();
  return useQuery({
    queryKey: queryKeys.trash.summary,
    queryFn: ({ signal }) => api.trashSummary({ signal }),
    enabled: can("delete_videos"),
  });
}

/** Days a deleted video waits; undefined until the summary has loaded. */
export function useTrashRetentionDays(): number | undefined {
  return useTrashSummary().data?.retention_days;
}

/** The trashed videos, newest first, one page at a time. */
export function useTrashList(enabled: boolean) {
  const query = useInfiniteQuery({
    queryKey: queryKeys.trash.list,
    queryFn: ({ pageParam, signal }) =>
      api.listTrashPage({ cursor: pageParam, limit: TRASH_PAGE_SIZE, signal }),
    initialPageParam: null as string | null,
    getNextPageParam: (last: Page<TrashItem>) => last.next_cursor ?? undefined,
    enabled,
    staleTime: 0,
  });
  const items = useMemo(
    () => query.data?.pages.flatMap((p) => p.items) ?? NO_ITEMS,
    [query.data]
  );
  return { ...query, items };
}

/** A failed delete in words; a video the trash cannot take says why. */
export function deleteErrorMessage(
  err: unknown,
  fallback = "Could not delete video"
): string {
  if (err instanceof ApiError && err.code === "trash_cross_device")
    return `Could not move the video to the trash. ${err.message}`;
  return describeError(err, fallback);
}

/**
 * Everything a delete, restore or erase can change: library lists and counts,
 * channels, tags, playlists, the review inbox, the trash and the disk usage.
 */
export function invalidateAfterTrashChange(queryClient: QueryClient): void {
  for (const queryKey of [
    queryKeys.videos.all,
    queryKeys.channels.all,
    queryKeys.tags.all,
    queryKeys.playlists.all,
    queryKeys.review.count,
    queryKeys.trash.all,
    queryKeys.system.storage,
  ]) {
    void queryClient.invalidateQueries({ queryKey });
  }
}

/**
 * After a delete: refresh what it changed and, when the videos went to the
 * trash, show `message` with an Undo that restores them. `onRestored` lets a
 * screen that keeps its own list (not a query) reload it.
 */
export function useAfterDelete() {
  const queryClient = useQueryClient();
  const { showToast, showError } = useToast();

  const undo = useCallback(
    async (entryIds: number[], onRestored?: () => void) => {
      const restored: string[] = [];
      const errors: string[] = [];
      for (const id of entryIds) {
        try {
          restored.push((await api.restoreFromTrash(id)).title);
        } catch (err) {
          errors.push(describeError(err, "Could not restore the video"));
        }
      }
      invalidateAfterTrashChange(queryClient);
      if (restored.length) onRestored?.();
      if (restored.length === 1) showToast(`Restored “${restored[0]}”`);
      else if (restored.length > 1)
        showToast(`Restored ${restored.length} videos`);
      if (errors.length) {
        showError(
          errors.length === 1
            ? `Could not restore: ${errors[0]}`
            : `Could not restore ${errors.length} videos: ${errors[0]}`
        );
      }
    },
    [queryClient, showToast, showError]
  );

  return useCallback(
    (entryIds: number[], message: string, onRestored?: () => void) => {
      invalidateAfterTrashChange(queryClient);
      if (!entryIds.length) {
        showToast(message);
        return;
      }
      showToast(message, {
        action: {
          label: "Undo",
          onClick: () => void undo(entryIds, onRestored),
        },
      });
    },
    [queryClient, showToast, undo]
  );
}
