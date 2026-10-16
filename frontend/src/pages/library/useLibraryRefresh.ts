import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../../api";
import { useDownloads } from "../../context/DownloadContext";
import { queryKeys } from "../../queries/keys";
import {
  prependVideoToList,
  replaceVideoInLists,
  type VideoFilters,
} from "../../queries/videos";

/**
 * Keeps the library in step with the server: a manual refresh after bulk edits
 * and a coalesced one after downloads finish.
 */
export function useLibraryRefresh(mainFilters: VideoFilters) {
  const queryClient = useQueryClient();
  const { onJobCompleted } = useDownloads();
  // Bumped on every refresh, so searches that are not queries re-run too.
  const [refreshKey, setRefreshKey] = useState(0);
  const mainFiltersRef = useRef(mainFilters);
  mainFiltersRef.current = mainFilters;

  // Re-read everything derived from the library (after downloads, bulk edits).
  const refreshLibrary = useCallback(() => {
    setRefreshKey((k) => k + 1);
    for (const queryKey of [
      queryKeys.videos.all,
      queryKeys.channels.all,
      queryKeys.tags.all,
    ]) {
      void queryClient.invalidateQueries({ queryKey });
    }
  }, [queryClient]);

  const backgroundRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  // Coalesce several job completions into one full-library refetch instead of one each.
  const scheduleBackgroundRefresh = useCallback(() => {
    if (backgroundRefreshTimer.current) {
      clearTimeout(backgroundRefreshTimer.current);
    }
    backgroundRefreshTimer.current = setTimeout(() => {
      backgroundRefreshTimer.current = null;
      refreshLibrary();
    }, 4000);
  }, [refreshLibrary]);

  useEffect(() => {
    return onJobCompleted((videoId) => {
      if (videoId == null) {
        scheduleBackgroundRefresh();
        return;
      }
      api
        .getVideo(videoId)
        .then((video) => {
          // Show it at once; the coalesced refresh below reconciles the lists.
          replaceVideoInLists(queryClient, video);
          prependVideoToList(queryClient, mainFiltersRef.current, video);
        })
        .catch(() => undefined);
      scheduleBackgroundRefresh();
    });
  }, [onJobCompleted, scheduleBackgroundRefresh, queryClient]);

  const reloadChannels = useCallback(
    () => queryClient.invalidateQueries({ queryKey: queryKeys.channels.all }),
    [queryClient]
  );

  return { refreshKey, refreshLibrary, reloadChannels };
}
