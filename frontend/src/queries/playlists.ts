import { useMemo } from "react";
import { useQuery, type QueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type { Playlist, PlaylistDetail } from "../types";
import { queryKeys } from "./keys";

const NO_PLAYLISTS: Playlist[] = [];

/** The playlists this user can see, revalidated on every visit so other pages' changes show. */
export function usePlaylists(enabled = true) {
  const query = useQuery({
    queryKey: queryKeys.playlists.list,
    queryFn: ({ signal }) => api.listPlaylists({ signal }),
    enabled,
    staleTime: 0,
  });
  const playlists = query.data ?? NO_PLAYLISTS;
  // Pickers offer only the playlists this user may add to.
  const editable = useMemo(
    () => playlists.filter((p) => p.can_edit),
    [playlists]
  );
  return { ...query, playlists, editable };
}

/** One playlist with its videos; read while its row is open. */
export function usePlaylistDetail(id: number, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.playlists.detail(id),
    queryFn: ({ signal }) => api.getPlaylist(id, { signal }),
    enabled,
    staleTime: 0,
  });
}

export function setPlaylistList(
  queryClient: QueryClient,
  update: (prev: Playlist[]) => Playlist[]
): void {
  queryClient.setQueryData<Playlist[]>(queryKeys.playlists.list, (prev) =>
    update(prev ?? NO_PLAYLISTS)
  );
}

/** Copy the list-row fields of `next` into the cached list (and detail unless `detail: false`). */
export function mergePlaylist(
  queryClient: QueryClient,
  next: Playlist,
  { detail = true }: { detail?: boolean } = {}
): void {
  setPlaylistList(queryClient, (prev) =>
    prev.map((row) =>
      row.id === next.id
        ? {
            ...row,
            name: next.name,
            description: next.description,
            source_type: next.source_type,
            source_url: next.source_url,
            subscribed: next.subscribed,
            quality_preset: next.quality_preset,
            last_synced_at: next.last_synced_at,
            sync_error: next.sync_error,
            item_count: next.item_count,
            position: next.position,
            cover_video_id: next.cover_video_id,
            has_custom_cover: next.has_custom_cover,
            thumbnail_video_id: next.thumbnail_video_id,
            has_thumbnail: next.has_thumbnail,
            visibility: next.visibility,
            owner: next.owner,
            can_edit: next.can_edit,
          }
        : row
    )
  );
  if (!detail) return;
  queryClient.setQueryData<PlaylistDetail>(
    queryKeys.playlists.detail(next.id),
    (cached) => cached && { ...cached, ...next, videos: cached.videos }
  );
}

/** Store a freshly read playlist (with its videos) and sync the list row. */
export function setPlaylistDetail(
  queryClient: QueryClient,
  detail: PlaylistDetail
): void {
  queryClient.setQueryData(queryKeys.playlists.detail(detail.id), detail);
  mergePlaylist(queryClient, detail);
}
