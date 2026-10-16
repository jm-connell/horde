import { Suspense, useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../context/AuthContext";
import { useToast } from "../context/ToastContext";
import { describeError } from "../apiErrors";
import { Link, useNavigate } from "react-router-dom";
import { api, listThumbnailUrl, playlistCoverUrl } from "../api";
import Collapse from "./Collapse";
import { ImageCropModal } from "./lazy";
import LoadingIndicator from "./LoadingIndicator";
import {
  CoverEditIcon,
  DragHandle,
  ExpandChevron,
  PlaylistThumb,
  beginReorderDrag,
} from "./playlistChrome";
import { useConfirm } from "../context/ConfirmContext";
import { usePlayback } from "../context/PlaybackContext";
import { queryKeys } from "../queries/keys";
import {
  mergePlaylist,
  setPlaylistDetail,
  usePlaylistDetail,
} from "../queries/playlists";
import type { Playlist, Video } from "../types";
import { formatDuration, formatRelative, moveItem, safeHref } from "../utils";
import PlaylistAddVideo from "./PlaylistAddVideo";

export default function PlaylistRow({
  playlist,
  open,
  dragging,
  dragOver,
  onToggle,
  onDeleted,
  onPlaylistDragStart,
  onPlaylistDragOver,
  onPlaylistDrop,
  onPlaylistDragEnd,
}: {
  playlist: Playlist;
  open: boolean;
  dragging?: boolean;
  dragOver?: boolean;
  onToggle: () => void;
  onDeleted: () => void;
  onPlaylistDragStart: (id: number) => void;
  onPlaylistDragOver: (id: number) => void;
  onPlaylistDrop: (id: number) => void;
  onPlaylistDragEnd: () => void;
}) {
  const { can } = useAuth();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const { showError } = useToast();
  const { playVideo, addToQueue } = usePlayback();
  const headerRef = useRef<HTMLDivElement>(null);
  const coverInputRef = useRef<HTMLInputElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const skipNameSaveRef = useRef(false);
  const queryClient = useQueryClient();
  const detailQuery = usePlaylistDetail(playlist.id, open);
  const loadError = detailQuery.isError ? "Could not load playlist" : null;
  const loading = detailQuery.isFetching;
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [coverDraft, setCoverDraft] = useState<File | null>(null);
  const [coverRev, setCoverRev] = useState(0);
  const [draftName, setDraftName] = useState(playlist.name);
  const videoDragIndex = useRef<number | null>(null);
  const [videoDragOver, setVideoDragOver] = useState<number | null>(null);

  const current = detailQuery.data ?? null;
  const coverSrc = playlistCoverUrl(playlist);
  const coverSrcBusted =
    coverSrc && playlist.has_custom_cover && coverRev
      ? `${coverSrc}&r=${coverRev}`
      : coverSrc;

  const reload = () =>
    queryClient.invalidateQueries({
      queryKey: queryKeys.playlists.detail(playlist.id),
    });

  // A freshly read playlist also refreshes its row in the list (video count, cover).
  const loaded = detailQuery.data;
  useEffect(() => {
    if (loaded) mergePlaylist(queryClient, loaded, { detail: false });
  }, [loaded, queryClient]);

  useEffect(() => {
    if (!open) setEditing(false);
  }, [open]);

  useEffect(() => {
    if (!editing) return;
    skipNameSaveRef.current = false;
    setDraftName(playlist.name);
    const t = window.setTimeout(() => {
      nameInputRef.current?.focus();
      nameInputRef.current?.select();
    }, 0);
    return () => window.clearTimeout(t);
    // Only reset the draft when the editor opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset the draft only when the editor opens, not on every rename
  }, [editing]);

  const playAll = () => {
    if (!current || current.videos.length === 0) return;
    const [first, ...rest] = current.videos;
    playVideo(first, { queue: rest });
    navigate(`/watch/${first.id}`);
  };

  const removeMutation = useMutation({
    mutationFn: (videoId: number) =>
      api.removeFromPlaylist(playlist.id, videoId),
    onError: (err) =>
      showError(`Could not remove video: ${describeError(err)}`),
    onSettled: () => reload(),
  });
  const remove = (videoId: number) => removeMutation.mutate(videoId);

  const deleteMutation = useMutation({
    mutationFn: () => api.deletePlaylist(playlist.id),
    onSuccess: () => onDeleted(),
    onError: (err) =>
      showError(`Could not delete playlist: ${describeError(err)}`),
  });
  const onDelete = async () => {
    const ok = await confirm({
      title: "Delete this playlist?",
      body: `"${playlist.name}" will be deleted. Videos stay in your library.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (ok) deleteMutation.mutate();
  };

  const syncMutation = useMutation({
    mutationFn: () => api.syncPlaylist(playlist.id),
    onMutate: () => setSyncMessage(null),
    onSuccess: () => {
      setSyncMessage("Sync started — new videos will appear as they download.");
      window.setTimeout(() => void reload(), 1500);
    },
    onError: (err) => showError(`Sync failed: ${describeError(err)}`),
  });
  const onSync = () => syncMutation.mutate();

  // Every edit of the playlist itself: the server returns the new row.
  const updateMutation = useMutation({
    mutationFn: (v: {
      patch: Parameters<typeof api.updatePlaylist>[1];
      success?: string | null;
      failure: string;
    }) => api.updatePlaylist(playlist.id, v.patch),
    onSuccess: (updated, v) => {
      mergePlaylist(queryClient, updated);
      if (v.success !== undefined) setSyncMessage(v.success);
    },
    onError: (err, v) => showError(`${v.failure}: ${describeError(err)}`),
  });
  const onStopSubscribing = () =>
    updateMutation.mutate({
      patch: { subscribed: false },
      success: null,
      failure: "Could not stop subscribing",
    });
  const onSubscribeUpdates = () =>
    updateMutation.mutate({
      patch: { subscribed: true },
      success: "Subscribed — Horde will check for new videos on a schedule.",
      failure: "Could not subscribe",
    });
  const saveName = async () => {
    const next = draftName.trim();
    if (!next) {
      setDraftName(playlist.name);
      return;
    }
    if (next === playlist.name) return;
    try {
      await updateMutation.mutateAsync({
        patch: { name: next },
        failure: "Could not rename playlist",
      });
    } catch {
      setDraftName(playlist.name);
    }
  };
  const setCoverVideo = (videoId: number | null) =>
    updateMutation.mutate({
      patch: { cover_video_id: videoId },
      failure: "Could not update cover",
    });

  const clearCoverDraft = () => {
    setCoverDraft(null);
    if (coverInputRef.current) coverInputRef.current.value = "";
  };

  const coverMutation = useMutation({
    mutationFn: (file: File) => api.uploadPlaylistCover(playlist.id, file),
    onSuccess: (updated) => {
      mergePlaylist(queryClient, updated);
      setCoverRev(Date.now());
      clearCoverDraft();
    },
    onError: (err) =>
      showError(`Could not upload cover: ${describeError(err)}`),
  });
  const onUploadCover = async (file: File) => {
    await coverMutation.mutateAsync(file);
  };

  const orderMutation = useMutation({
    mutationFn: (videos: Video[]) =>
      api.reorderPlaylist(
        playlist.id,
        videos.map((v) => v.id)
      ),
    onMutate: (videos) => {
      if (current) {
        queryClient.setQueryData(queryKeys.playlists.detail(playlist.id), {
          ...current,
          videos,
        });
      }
    },
    onSuccess: (next) => setPlaylistDetail(queryClient, next),
    onError: () => void reload(),
  });
  const commitVideoOrder = (videos: Video[]) => {
    if (current) orderMutation.mutate(videos);
  };

  const actionBusy =
    updateMutation.isPending ||
    syncMutation.isPending ||
    coverMutation.isPending;

  const youtubeImported = playlist.source_type === "youtube";
  const sourceHint = playlist.subscribed
    ? " · subscribed from YouTube"
    : youtubeImported
      ? " · imported from YouTube"
      : "";
  const videoCount = current?.videos.length ?? playlist.item_count;
  const coverPinned =
    playlist.has_custom_cover || playlist.cover_video_id != null;

  return (
    <div
      id={`playlist-row-${playlist.id}`}
      onDragOver={(event) => {
        event.preventDefault();
        onPlaylistDragOver(playlist.id);
      }}
      onDrop={(event) => {
        event.preventDefault();
        onPlaylistDrop(playlist.id);
      }}
      className={`ui-panel scroll-mt-24 rounded-xl bg-ink-900 ring-1 transition-colors ${
        dragging ? "opacity-60" : ""
      } ${
        dragOver
          ? "ring-accent/70"
          : open
            ? "ring-accent/50"
            : "ring-ink-700 hover:ring-accent/60"
      }`}
    >
      <div
        ref={headerRef}
        className="flex cursor-pointer items-stretch"
        // Pointer shortcut; the expand/collapse button below is the keyboard path.
        role="presentation"
        onClick={onToggle}
      >
        <DragHandle
          label="Drag to reorder playlists"
          onDragStart={(event) => {
            beginReorderDrag(event, String(playlist.id), headerRef.current);
            onPlaylistDragStart(playlist.id);
          }}
          onDragEnd={onPlaylistDragEnd}
        />
        <div className="flex min-w-0 flex-1 items-center gap-3 py-2.5 pr-2">
          <PlaylistThumb
            src={coverSrcBusted}
            className="h-[5.5rem] w-[9.75rem] shrink-0 rounded-lg"
          />
          <div className="min-w-0 flex-1">
            <h3 className="min-w-0">
              {editing ? (
                <input
                  ref={nameInputRef}
                  aria-label="Playlist name"
                  value={draftName}
                  disabled={actionBusy}
                  onChange={(e) => setDraftName(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onBlur={() => {
                    if (skipNameSaveRef.current) return;
                    void saveName();
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void saveName();
                      e.currentTarget.blur();
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      skipNameSaveRef.current = true;
                      setDraftName(playlist.name);
                      setEditing(false);
                    }
                  }}
                  className="w-full min-w-0 rounded-md border border-ink-600 bg-ink-950 px-2 py-0.5 font-semibold text-gray-100 outline-none focus:border-accent disabled:opacity-50"
                />
              ) : (
                <span className="block truncate font-semibold text-gray-100">
                  {playlist.name}
                </span>
              )}
            </h3>
            <p className="text-xs text-muted">
              {videoCount} video{videoCount === 1 ? "" : "s"}
              {sourceHint}
              {playlist.subscribed && playlist.last_synced_at
                ? ` · synced ${formatRelative(playlist.last_synced_at)}`
                : ""}
            </p>
            {playlist.subscribed && (
              <span className="ui-panel mt-1.5 inline-block rounded-lg border border-ink-700 bg-ink-950 px-2.5 py-1 text-xs text-gray-300">
                Subscribed
              </span>
            )}
          </div>
        </div>
        <button
          type="button"
          title="Edit playlist"
          aria-label="Edit playlist"
          aria-pressed={editing}
          onClick={(event) => {
            event.stopPropagation();
            if (editing) void saveName();
            if (!editing && !open) onToggle();
            setEditing((on) => !on);
          }}
          className="ui-interactive self-center"
        >
          <CoverEditIcon active={editing} />
        </button>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={`playlist-panel-${playlist.id}`}
          aria-label={open ? "Collapse playlist" : "Expand playlist"}
          onClick={(event) => {
            event.stopPropagation();
            onToggle();
          }}
          className="ui-interactive group flex items-center self-stretch pr-2"
        >
          <ExpandChevron open={open} />
        </button>
      </div>

      <Collapse open={open}>
        <div
          id={`playlist-panel-${playlist.id}`}
          role="region"
          className="border-t border-ink-800 px-4 pb-4 pt-3 sm:px-5"
        >
          {loading && !current ? (
            <LoadingIndicator className="py-8" />
          ) : loadError ? (
            <p className="py-6 text-center text-sm text-muted">{loadError}</p>
          ) : (
            <>
              <div className="flex flex-wrap items-start gap-2">
                <div className="flex min-w-0 flex-1 flex-nowrap items-start gap-2">
                  <button
                    type="button"
                    onClick={playAll}
                    disabled={!current || current.videos.length === 0}
                    className="shrink-0 rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-ink-950 hover:bg-accent-soft disabled:opacity-50"
                  >
                    Play all
                  </button>
                  {playlist.subscribed && (
                    <button
                      type="button"
                      onClick={onSync}
                      disabled={actionBusy}
                      className="shrink-0 rounded-lg border border-ink-600 px-3 py-1.5 text-sm text-gray-300 hover:border-accent hover:text-accent disabled:opacity-50"
                    >
                      Sync now
                    </button>
                  )}
                  <PlaylistAddVideo
                    playlistId={playlist.id}
                    memberIds={
                      new Set((current?.videos ?? []).map((v) => v.id))
                    }
                    active={open}
                    onAdded={(next) => setPlaylistDetail(queryClient, next)}
                  />
                </div>
                <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
                  {playlist.subscribed && (
                    <button
                      type="button"
                      onClick={onStopSubscribing}
                      disabled={actionBusy}
                      className="shrink-0 rounded-lg border border-amber-500/40 px-3 py-1.5 text-sm text-amber-400 hover:bg-amber-500/10 disabled:opacity-50"
                    >
                      Stop subscription
                    </button>
                  )}
                  {youtubeImported && !playlist.subscribed && (
                    <button
                      type="button"
                      onClick={onSubscribeUpdates}
                      disabled={actionBusy}
                      className="shrink-0 rounded-lg border border-ink-600 px-3 py-1.5 text-sm text-gray-300 hover:border-accent hover:text-accent disabled:opacity-50"
                    >
                      Subscribe to updates
                    </button>
                  )}
                  {can("manage_playlists") && (
                    <button
                      type="button"
                      onClick={onDelete}
                      className="shrink-0 rounded-lg border border-red-500/40 px-3 py-1.5 text-sm text-red-400 hover:bg-red-500/10"
                    >
                      Delete
                    </button>
                  )}
                  {safeHref(playlist.source_url) && (
                    <a
                      href={safeHref(playlist.source_url)}
                      target="_blank"
                      rel="noreferrer"
                      className="shrink-0 text-sm text-accent hover:underline"
                    >
                      Source playlist ↗
                    </a>
                  )}
                </div>
              </div>
              {playlist.sync_error && (
                <p className="mt-2 text-sm text-red-400">
                  {playlist.sync_error}
                </p>
              )}
              {syncMessage && (
                <p className="mt-2 text-sm text-accent">{syncMessage}</p>
              )}

              {editing && (
                <div className="mt-4">
                  <div className="mb-2 flex items-baseline justify-between gap-2">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted">
                      Cover
                    </p>
                    {coverPinned && (
                      <button
                        type="button"
                        disabled={actionBusy}
                        onClick={() => setCoverVideo(null)}
                        className="text-xs text-gray-400 hover:text-accent disabled:opacity-50"
                      >
                        Use first video
                      </button>
                    )}
                  </div>
                  <div className="flex gap-2 overflow-x-auto pb-1 horde-scrollbar">
                    {(current?.videos ?? []).map((video, index) => {
                      const selected =
                        !playlist.has_custom_cover &&
                        (playlist.cover_video_id === video.id ||
                          (playlist.cover_video_id == null && index === 0));
                      const src = video.has_thumbnail
                        ? listThumbnailUrl(video.id)
                        : null;
                      return (
                        <button
                          key={video.id}
                          type="button"
                          disabled={actionBusy}
                          title={
                            index === 0 && playlist.cover_video_id == null
                              ? "Default (first video)"
                              : `Use thumbnail from ${video.title}`
                          }
                          onClick={() => {
                            if (
                              index === 0 &&
                              playlist.cover_video_id == null &&
                              !playlist.has_custom_cover
                            ) {
                              return;
                            }
                            setCoverVideo(index === 0 ? null : video.id);
                          }}
                          className={`relative w-20 shrink-0 overflow-hidden rounded-md ring-1 ${
                            selected
                              ? "ring-accent"
                              : "ring-ink-700 hover:ring-ink-500"
                          }`}
                        >
                          <PlaylistThumb
                            src={src}
                            className="aspect-video w-full"
                          />
                          {index === 0 && playlist.cover_video_id == null && (
                            <span className="absolute bottom-0.5 left-0.5 rounded bg-ink-950/80 px-1 py-px text-[9px] font-medium uppercase tracking-wide text-gray-300">
                              Auto
                            </span>
                          )}
                        </button>
                      );
                    })}
                    <button
                      type="button"
                      disabled={actionBusy}
                      onClick={() => coverInputRef.current?.click()}
                      className={`flex aspect-video w-20 shrink-0 flex-col items-center justify-center rounded-md border border-dashed text-[10px] uppercase tracking-wide ${
                        playlist.has_custom_cover
                          ? "border-accent text-accent"
                          : "border-ink-600 text-muted hover:border-ink-500 hover:text-gray-300"
                      }`}
                    >
                      {playlist.has_custom_cover ? "Custom" : "Upload"}
                    </button>
                    <input
                      ref={coverInputRef}
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file) setCoverDraft(file);
                        else if (coverInputRef.current) {
                          coverInputRef.current.value = "";
                        }
                      }}
                    />
                  </div>
                </div>
              )}

              <div className="mt-3 space-y-2">
                {!current || current.videos.length === 0 ? (
                  <p className="py-8 text-center text-sm text-muted">
                    {youtubeImported
                      ? "Videos will appear here as they finish downloading."
                      : "No videos yet. Search your library or paste a download link."}
                  </p>
                ) : (
                  current.videos.map((v, i) => {
                    const thumb = v.has_thumbnail
                      ? listThumbnailUrl(v.id)
                      : null;
                    return (
                      <div
                        key={v.id}
                        onDragOver={(event) => {
                          if (videoDragIndex.current == null) return;
                          event.preventDefault();
                          event.stopPropagation();
                          setVideoDragOver(i);
                        }}
                        onDrop={(event) => {
                          if (videoDragIndex.current == null) return;
                          event.preventDefault();
                          event.stopPropagation();
                          const from = videoDragIndex.current;
                          videoDragIndex.current = null;
                          setVideoDragOver(null);
                          if (!current) return;
                          const next = moveItem(current.videos, from, i);
                          commitVideoOrder(next);
                        }}
                        className={`flex items-center gap-1 rounded-lg bg-ink-950/70 p-2 ring-1 ${
                          videoDragOver === i
                            ? "ring-accent/60"
                            : "ring-ink-800"
                        }`}
                      >
                        <DragHandle
                          label="Drag to reorder videos"
                          onDragStart={(event) => {
                            event.stopPropagation();
                            beginReorderDrag(event, String(v.id));
                            videoDragIndex.current = i;
                          }}
                          onDragEnd={() => {
                            videoDragIndex.current = null;
                            setVideoDragOver(null);
                          }}
                        />
                        <span className="w-6 shrink-0 text-center text-sm text-muted">
                          {i + 1}
                        </span>
                        <Link
                          to={`/watch/${v.id}`}
                          className="flex min-w-0 flex-1 items-center gap-3"
                        >
                          <div className="relative h-14 w-24 shrink-0 overflow-hidden rounded bg-ink-800">
                            {thumb && (
                              <img
                                loading="lazy"
                                decoding="async"
                                width={96}
                                height={56}
                                src={thumb}
                                alt=""
                                className="h-full w-full object-cover"
                              />
                            )}
                          </div>
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-gray-100">
                              {v.title}
                            </p>
                            <p className="text-xs text-muted">
                              {v.channel} · {formatDuration(v.duration_sec)}
                            </p>
                          </div>
                        </Link>
                        <button
                          type="button"
                          onClick={() => addToQueue(v)}
                          className="shrink-0 rounded px-2 py-1 text-xs text-gray-400 hover:text-accent"
                          title="Add to queue"
                        >
                          + Queue
                        </button>
                        <button
                          type="button"
                          onClick={() => remove(v.id)}
                          className="shrink-0 px-2 text-muted hover:text-accent"
                          title="Remove from playlist"
                        >
                          ✕
                        </button>
                      </div>
                    );
                  })
                )}
              </div>
            </>
          )}
        </div>
      </Collapse>
      {coverDraft ? (
        <Suspense fallback={null}>
          <ImageCropModal
            file={coverDraft}
            title="Edit playlist cover"
            confirmLabel="Use cover"
            onCancel={clearCoverDraft}
            onConfirm={onUploadCover}
          />
        </Suspense>
      ) : null}
    </div>
  );
}
