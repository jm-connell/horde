import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api";
import { queryKeys } from "../../queries/keys";
import { replaceVideoInLists, videoDetailQuery } from "../../queries/videos";
import { usePlaybackActions } from "../../context/PlaybackContext";
import type { StreamPreviewMeta, Video } from "../../types";
import { parseChapters } from "../../utils";
import { clearWatchResume, peekWatchResume } from "../../utils/watchHandoff";

export type WatchSource =
  | { kind: "library"; video: Video }
  | { kind: "stream"; url: string; meta: StreamPreviewMeta };

/**
 * Loads what the watch page shows: a library video (kept current while the
 * server is still processing it) or the metadata of a not-yet-downloaded
 * stream, and hands it to the player.
 */
export function useWatchVideo({
  libraryId,
  libraryValid,
  streamUrlParam,
  channelParam,
  startParam = null,
}: {
  libraryId: number;
  libraryValid: boolean;
  streamUrlParam: string;
  channelParam: string;
  /** `?t=`: start here instead of the saved position. */
  startParam?: number | null;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const { playVideo, playStream, suspendPlaybackMedia, updateCurrentVideo } =
    usePlaybackActions();
  const [source, setSource] = useState<WatchSource | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // --- Load library video ---
  const libraryQuery = useQuery({
    ...videoDetailQuery(libraryId),
    // Negative ids are offline-only device downloads (see offline/manager).
    enabled: libraryValid,
    // Keep this page's copy current while the server is still working on it
    // (subtitles, summary, sprites, chapters).
    refetchInterval: (query) => {
      const v = query.state.data;
      return v &&
        (v.subtitles_pending ||
          v.processing_summary ||
          v.processing_sprites ||
          v.processing_chapters)
        ? 3000
        : false;
    },
  });
  const handedOffRef = useRef<number | null>(null);
  /** The `?t=` already handed to the player (a different one seeks). */
  const appliedStartRef = useRef<number | null>(null);
  // Read by the load effects without restarting them: a new `t` only seeks.
  const startRef = useRef(startParam);
  startRef.current = startParam;

  useEffect(() => {
    if (!libraryValid) return;
    handedOffRef.current = null;
    suspendPlaybackMedia({ videoId: libraryId });
    setLoading(true);
    setError(null);
  }, [libraryId, libraryValid, suspendPlaybackMedia]);

  useEffect(() => {
    if (!libraryValid) return;
    // A failed refresh of a video that is already playing must not replace it.
    if (libraryQuery.isLoadingError) {
      setError("Video not found");
      setLoading(false);
      return;
    }
    const v = libraryQuery.data;
    if (!v) return;
    if (handedOffRef.current === libraryId) {
      // A later refresh of the same video: update, do not restart playback.
      setSource({ kind: "library", video: v });
      updateCurrentVideo(v);
      return;
    }
    handedOffRef.current = libraryId;
    const fromHandoff = peekWatchResume(libraryId);
    const navResume = (location.state as { resumeAt?: number } | null)
      ?.resumeAt;
    const resumeAt =
      fromHandoff ??
      (typeof navResume === "number" && navResume > 1 ? navResume : null);
    const merged =
      startParam != null
        ? { ...v, last_position_sec: startParam }
        : resumeAt != null && resumeAt > 1
          ? { ...v, last_position_sec: resumeAt }
          : v;
    appliedStartRef.current = startParam;
    clearWatchResume(libraryId);
    setSource({ kind: "library", video: merged });
    playVideo(merged);
    setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional handoff once per video; the resume position comes from the navigation state at that moment
  }, [libraryQuery.data, libraryQuery.isLoadingError, libraryId, libraryValid]);

  // A new `?t=` for the video that is already playing seeks instead of reloading.
  useEffect(() => {
    if (startParam == null || appliedStartRef.current === startParam) return;
    if (!source) return;
    appliedStartRef.current = startParam;
    window.dispatchEvent(
      new CustomEvent("horde:seek", { detail: { sec: startParam } })
    );
  }, [startParam, source]);

  // --- Load stream meta ---
  const streamMode = !libraryValid && !!streamUrlParam;
  const metaQuery = useQuery({
    queryKey: queryKeys.preview.meta(streamUrlParam),
    queryFn: ({ signal }) => api.getPreviewMeta(streamUrlParam, { signal }),
    enabled: streamMode,
  });

  useEffect(() => {
    if (libraryValid) return;
    if (!streamUrlParam) {
      setError("Missing video URL");
      setLoading(false);
      return;
    }
    suspendPlaybackMedia({ streamUrl: streamUrlParam });
    setLoading(true);
    setError(null);
    setSource(null);
  }, [streamUrlParam, libraryValid, suspendPlaybackMedia]);

  useEffect(() => {
    if (!streamMode) return;
    if (metaQuery.isLoadingError) {
      const err = metaQuery.error;
      setError(err instanceof Error ? err.message : "Could not load stream");
      setLoading(false);
      return;
    }
    const meta = metaQuery.data;
    if (!meta) return;
    if (meta.library_video_id != null) {
      const t = startRef.current;
      const start = t != null ? `?t=${t}` : "";
      navigate(`/watch/${meta.library_video_id}${start}`, { replace: true });
      return;
    }
    appliedStartRef.current = startRef.current;
    setSource({ kind: "stream", url: streamUrlParam, meta });
    setLoading(false);
  }, [
    streamMode,
    metaQuery.data,
    metaQuery.isLoadingError,
    metaQuery.error,
    streamUrlParam,
    navigate,
  ]);

  // Start stream playback
  useEffect(() => {
    if (source?.kind !== "stream") return;
    playStream({
      url: source.url,
      title: source.meta.title || "Untitled",
      channel: source.meta.channel ?? null,
      poster: source.meta.thumbnail_url ?? null,
      chapters: source.meta.is_live
        ? []
        : parseChapters(source.meta.description),
      sourceUrl: source.meta.source_url,
      channelParam: channelParam || source.meta.channel,
      subtitles: source.meta.is_live ? [] : (source.meta.subtitles ?? []),
      liveVideoId: source.meta.is_live ? (source.meta.id ?? null) : null,
      storyboard: source.meta.storyboard ?? null,
      durationSec: source.meta.duration ?? null,
      channelUrl: source.meta.channel_url ?? null,
      startSec: appliedStartRef.current,
    });
  }, [source, channelParam, playStream]);

  /** Show an edited copy of the library video here, in the player and in the lists. */
  const setVideo = useCallback(
    (v: Video) => {
      setSource({ kind: "library", video: v });
      updateCurrentVideo(v);
      // The library lists and this page's copy show the edit too.
      queryClient.setQueryData(queryKeys.videos.detail(v.id), v);
      replaceVideoInLists(queryClient, v);
    },
    [updateCurrentVideo, queryClient]
  );

  return { source, setSource, loading, error, setVideo };
}
