import SafariPrepGate from "../components/SafariPrepGate";
import CompatGate from "../components/CompatGate";
import { useLibraryRendition } from "../hooks/useLibraryRendition";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import {
  api,
  liveMasterUrl,
  previewManifestUrl,
  previewStreamUrl,
  previewSubtitleUrl,
  streamUrl,
  subtitleUrl,
  thumbnailUrl,
} from "../api";
import VideoPlayer, { type ViewMode } from "../components/VideoPlayer";
import { loadSettings, useSettings } from "../hooks/useSettings";
import { useIsMobile } from "../hooks/useIsMobile";
import { useSponsorBlock } from "../hooks/useSponsorBlock";
import { enabledSponsorBlockCategories } from "../sponsorBlock";
import {
  dedupeSubtitleTracks,
  resolveLibraryChapters,
  youtubeThumbnailUrl,
  type Chapter,
} from "../utils";
import { watchHref } from "../utils/watchHref";
import { shouldSuspendPlaybackForWatch } from "../utils/watchHandoff";
import {
  clampMiniPos,
  miniPlayerHostInsets,
  type MiniPos,
} from "../utils/miniPlayerLayout";
import type { SubtitleTrack, Video } from "../types";
import {
  isQueuedStream,
  type QueueEntry,
  withEntryAtEnd,
  withEntryFirst,
  withoutKey,
  withoutStream,
  withoutVideo,
} from "./playbackQueue";

import {
  applyMiniHostInsets,
  flipHostTransition,
  miniRectFromHost,
} from "./playback/miniHost";
import {
  mimeFromPath,
  streamExpandPath,
  withPlayingPosition,
} from "./playback/helpers";
import { useProgressSaver } from "../hooks/useProgressSaver";
import { useAccountPosition } from "../hooks/useAccountPosition";
import { getItem, getJson, removeItem, setItem, setJson } from "../storage";
export interface StreamSession {
  url: string;
  title: string;
  channel: string | null;
  poster: string | null;
  chapters: Chapter[];
  sourceUrl?: string | null;
  /** Channel query for expand / back navigation. */
  channelParam?: string | null;
  subtitles?: SubtitleTrack[];
  /** YouTube video id of a broadcast that is live: play `/api/live` HLS. */
  liveVideoId?: string | null;
}

export type MiniPlayerRect = {
  left: number;
  top: number;
  width: number;
  height: number;
  right: number;
  bottom: number;
};

/**
 * What is playing and how the page is laid out around it. Three contexts so a
 * component only re-renders for what it reads: the actions never change, the
 * session changes when playback does, and the layout changes while the
 * mini-player is dragged or the picture resizes.
 */
export interface PlaybackSession {
  current: Video | null;
  stream: StreamSession | null;
  queue: QueueEntry[];
  mode: ViewMode;
  /** True when the floating mini-player is showing (browsing away from Watch). */
  miniPlayerActive: boolean;
}

export interface PlaybackLayout {
  /** Live bounds of the floating mini-player (null when not mini). */
  miniPlayerRect: MiniPlayerRect | null;
  /** True until the user drags the mini player; then it keeps that pixel position. */
  miniPlayerCornerAnchor: boolean;
  /** Live DASH/file track quality (YouTube ladder), null until known. */
  activeStreamQuality: number | null;
  /** Pillarbox inset (px) of the visible picture inside the player box. */
  videoFrameInset: number;
}

export interface PlaybackActions {
  setMode: (mode: ViewMode) => void;
  playVideo: (video: Video, opts?: { queue?: Video[] }) => void;
  playStream: (session: StreamSession) => void;
  /** Latest stream playback position (seconds). */
  getStreamPosition: () => number;
  /** Latest library playback position (seconds). */
  getCurrentPosition: () => number;
  addToQueue: (entry: QueueEntry) => void;
  playNext: (entry: QueueEntry) => void;
  /** Remove by `queueKey(entry)`. */
  removeFromQueue: (key: string) => void;
  reorderQueue: (from: number, to: number) => void;
  clearQueue: () => void;
  close: () => void;
  /**
   * Abort the live media session when Watch is loading a different video
   * so the new preview can fetch without waiting on the current stream.
   */
  suspendPlaybackMedia: (next: {
    streamUrl?: string | null;
    videoId?: number | null;
  }) => void;
  registerDock: (el: HTMLElement | null) => void;
  /** Patch the playing library video when metadata refreshes (same id). */
  updateCurrentVideo: (video: Video) => void;
  /** Replace the chapters of the playing stream (e.g. AI chapters), if it is `url`. */
  setStreamChapters: (url: string, chapters: Chapter[]) => void;
}

const SessionCtx = createContext<PlaybackSession | null>(null);
const LayoutCtx = createContext<PlaybackLayout | null>(null);
const ActionsCtx = createContext<PlaybackActions | null>(null);

const QUEUE_KEY = "horde.queue";
const MINI_WIDTH_KEY = "horde.mini-width";
const DEFAULT_MINI_WIDTH_MOBILE = 224;
const DEFAULT_MINI_WIDTH_DESKTOP = 704;

function loadMiniWidth(): number | null {
  const raw = getItem(MINI_WIDTH_KEY);
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 160 && n <= 960 ? n : null;
}

function loadQueue(): QueueEntry[] {
  return getJson<QueueEntry[]>(
    QUEUE_KEY,
    (v): v is QueueEntry[] => Array.isArray(v),
    [],
    "session"
  );
}

export function PlaybackProvider({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  const [settings, updateSettings] = useSettings();
  const isMobile = useIsMobile();
  const [current, setCurrent] = useState<Video | null>(null);
  const [stream, setStream] = useState<StreamSession | null>(null);
  const [queue, setQueue] = useState<QueueEntry[]>(loadQueue);
  const [dock, setDock] = useState<HTMLElement | null>(null);
  const [mode, setModeState] = useState<ViewMode>(
    () => loadSettings().playbackMode
  );
  const [miniWidth, setMiniWidthState] = useState<number | null>(loadMiniWidth);
  // Session-only; always starts bottom-right when a miniplayer opens after close.
  const [miniPos, setMiniPosState] = useState<MiniPos | null>(null);
  const miniPosLiveRef = useRef<MiniPos | null>(null);
  const [miniCornerAnchor, setMiniCornerAnchor] = useState(true);
  const streamPosRef = useRef(0);
  const libraryPosRef = useRef(0);
  const recentWatchedRef = useRef<number[]>([]);
  const currentRef = useRef<Video | null>(null);
  const streamRef = useRef<StreamSession | null>(null);
  currentRef.current = current;
  streamRef.current = stream;
  const [miniPlayerRect, setMiniPlayerRect] = useState<MiniPlayerRect | null>(
    null
  );
  const [activeStreamQuality, setActiveStreamQuality] = useState<number | null>(
    null
  );
  const [videoFrameInset, setVideoFrameInset] = useState(0);
  const [mediaSuspended, setMediaSuspended] = useState(false);

  const setMiniWidth = useCallback((w: number | null) => {
    setMiniWidthState(w);
    if (w == null) removeItem(MINI_WIDTH_KEY);
    else setItem(MINI_WIDTH_KEY, String(w));
  }, []);

  const setMiniPos = useCallback((pos: MiniPos | null) => {
    setMiniPosState(pos);
    miniPosLiveRef.current = pos;
  }, []);

  // Persist the chosen view mode so it is remembered across sessions.
  const setMode = useCallback(
    (next: ViewMode) => {
      setModeState(next);
      updateSettings({ playbackMode: next });
    },
    [updateSettings]
  );

  // Mobile always uses the inline standard layout (no theater/fullscreen).
  const effectiveMode: ViewMode = isMobile ? "standard" : mode;

  const hostRef = useRef<HTMLDivElement | null>(null);
  if (hostRef.current === null) {
    hostRef.current = document.createElement("div");
  }

  const activeSession = Boolean(current || stream);

  // Persist the watch position for this account (throttled; see the hook).
  const streamPlayingRef = useRef(false);
  streamPlayingRef.current = stream !== null;
  const { noteSaved, startPosition } = useAccountPosition({
    currentRef,
    streamPlayingRef,
    hostRef,
    livePositionRef: libraryPosRef,
  });
  const progressSaver = useProgressSaver(noteSaved);

  useEffect(() => {
    setJson(QUEUE_KEY, queue, "session");
  }, [queue]);

  // Move the persistent player node into the watch dock, body (windowed), or a
  // floating mini-player while browsing. Using appendChild (not portal
  // re-targeting) keeps the <video> element alive so playback never restarts.
  const prevHostStateRef = useRef<
    "windowed" | "dock" | "mini" | "hidden" | null
  >(null);
  useEffect(() => {
    const host = hostRef.current!;
    const nextState: "windowed" | "dock" | "mini" | "hidden" =
      !isMobile && mode === "windowed" && activeSession
        ? "windowed"
        : dock && activeSession
          ? "dock"
          : activeSession
            ? "mini"
            : "hidden";
    const prevState = prevHostStateRef.current;
    // Only FLIP the dock <-> fullscreen "fit" jump; other transitions (e.g.
    // into/out of the floating mini player) already animate via their own
    // inset/position styles.
    const shouldFlip =
      (prevState === "dock" && nextState === "windowed") ||
      (prevState === "windowed" && nextState === "dock");
    const beforeRect = shouldFlip ? host.getBoundingClientRect() : null;

    if (nextState === "windowed") {
      document.body.appendChild(host);
      host.className = "fixed inset-0 z-50";
      host.style.width = "";
      host.style.maxWidth = "";
      host.style.left = "";
      host.style.top = "";
      host.style.right = "";
      host.style.bottom = "";
    } else if (nextState === "dock") {
      dock!.appendChild(host);
      host.className = "h-full w-full";
      host.style.width = "";
      host.style.maxWidth = "";
      host.style.left = "";
      host.style.top = "";
      host.style.right = "";
      host.style.bottom = "";
      host.style.height = "";
    } else if (nextState === "mini") {
      document.body.appendChild(host);
      const defaultWidth = isMobile
        ? DEFAULT_MINI_WIDTH_MOBILE
        : DEFAULT_MINI_WIDTH_DESKTOP;
      const width = miniWidth ?? defaultWidth;
      const pos = miniPosLiveRef.current ?? miniPos;
      const heightGuess = width * (9 / 16);
      host.style.width = `${width}px`;
      host.style.maxWidth = isMobile ? "70vw" : "calc(100vw - 2rem)";
      // Insets must be in the style attribute *before* `position: fixed`.
      // Measuring while fixed with auto insets snapshots the static
      // position as used left/top, which then ignore window resize.
      applyMiniHostInsets(
        host,
        miniPlayerHostInsets(pos, { width, height: heightGuess }, isMobile)
      );
      host.className =
        "fixed z-40 overflow-hidden rounded-xl shadow-2xl ring-1 ring-ink-700";
      if (pos) {
        const height = host.getBoundingClientRect().height || heightGuess;
        applyMiniHostInsets(
          host,
          miniPlayerHostInsets(pos, { width, height }, isMobile)
        );
      }
    } else {
      host.className = "hidden";
      host.style.width = "";
      host.style.maxWidth = "";
      host.style.left = "";
      host.style.top = "";
      host.style.right = "";
      host.style.bottom = "";
    }

    if (beforeRect) flipHostTransition(host, beforeRect);
    prevHostStateRef.current = nextState;
  }, [
    dock,
    current,
    stream,
    activeSession,
    isMobile,
    mode,
    miniWidth,
    miniPos,
  ]);

  const miniPlayerActive = Boolean(
    activeSession && !dock && !(!isMobile && mode === "windowed")
  );

  // Publish mini-player bounds so floating UI (download panel / queue) can avoid it.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !miniPlayerActive) {
      setMiniPlayerRect(null);
      return;
    }

    const publish = () => {
      const next = miniRectFromHost(host);
      if (next) setMiniPlayerRect(next);
    };

    const onWindowResize = () => {
      const defaultWidth = isMobile
        ? DEFAULT_MINI_WIDTH_MOBILE
        : DEFAULT_MINI_WIDTH_DESKTOP;
      const width = miniWidth ?? defaultWidth;
      const height = host.getBoundingClientRect().height || width * (9 / 16);
      const pos = miniPosLiveRef.current;
      if (pos) {
        const clamped = clampMiniPos(pos.left, pos.top, width, height);
        applyMiniHostInsets(
          host,
          miniPlayerHostInsets(clamped, { width, height }, isMobile)
        );
        if (clamped.left !== pos.left || clamped.top !== pos.top) {
          miniPosLiveRef.current = clamped;
          setMiniPosState(clamped);
        }
      } else {
        applyMiniHostInsets(
          host,
          miniPlayerHostInsets(null, { width, height }, isMobile)
        );
      }
      publish();
    };

    publish();
    const ro = new ResizeObserver(publish);
    ro.observe(host);
    window.addEventListener("resize", onWindowResize, { passive: true });
    window.visualViewport?.addEventListener("resize", onWindowResize, {
      passive: true,
    });
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", onWindowResize);
      window.visualViewport?.removeEventListener("resize", onWindowResize);
    };
  }, [
    miniPlayerActive,
    miniWidth,
    miniPos,
    current?.id,
    stream?.url,
    isMobile,
  ]);

  // Hide page scroll while windowed fullscreen is active.
  useEffect(() => {
    if (!isMobile && mode === "windowed" && activeSession) {
      document.body.style.overflow = "hidden";
      return () => {
        document.body.style.overflow = "";
      };
    }
  }, [isMobile, mode, activeSession]);

  useEffect(() => {
    const host = hostRef.current!;
    return () => {
      host.remove();
    };
  }, []);

  const playVideo = useCallback(
    (opened: Video, opts?: { queue?: Video[] }) => {
      const from = startPosition(opened);
      const video =
        from === opened.last_position_sec
          ? opened
          : { ...opened, last_position_sec: from };
      setMediaSuspended(false);
      setCurrent((prev) => {
        if (prev?.id != null && prev.id !== video.id) {
          recentWatchedRef.current = [
            prev.id,
            ...recentWatchedRef.current.filter((id) => id !== prev.id),
          ].slice(0, 12);
        }
        return video;
      });
      setStream(null);
      setActiveStreamQuality(null);
      streamPosRef.current = 0;
      libraryPosRef.current = video.last_position_sec || 0;
      if (opts?.queue) {
        setQueue(withoutVideo(opts.queue, video.id));
      } else {
        setQueue((q) => withoutVideo(q, video.id));
      }
    },
    [startPosition]
  );

  const playStream = useCallback((session: StreamSession) => {
    setCurrent(null);
    setMediaSuspended(false);
    setActiveStreamQuality(null);
    streamPosRef.current = 0;
    libraryPosRef.current = 0;
    setStream(session);
    setQueue((q) => withoutStream(q, session.url));
  }, []);

  const getStreamPosition = useCallback(() => streamPosRef.current, []);
  const getCurrentPosition = useCallback(() => libraryPosRef.current, []);

  const addToQueue = useCallback((entry: QueueEntry) => {
    setQueue((q) => withEntryAtEnd(q, entry));
  }, []);

  const playNext = useCallback((entry: QueueEntry) => {
    setQueue((q) => withEntryFirst(q, entry));
  }, []);

  const removeFromQueue = useCallback((key: string) => {
    setQueue((q) => withoutKey(q, key));
  }, []);

  const reorderQueue = useCallback((from: number, to: number) => {
    setQueue((q) => {
      if (
        from === to ||
        from < 0 ||
        to < 0 ||
        from >= q.length ||
        to >= q.length
      ) {
        return q;
      }
      const next = [...q];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  }, []);

  const clearQueue = useCallback(() => setQueue([]), []);

  const close = useCallback(() => {
    setCurrent(null);
    setStream(null);
    setMediaSuspended(false);
    setActiveStreamQuality(null);
    streamPosRef.current = 0;
    libraryPosRef.current = 0;
    setDock(null);
    setMiniPos(null);
    setMiniCornerAnchor(true);
  }, [setMiniPos]);

  const suspendPlaybackMedia = useCallback(
    (next: { streamUrl?: string | null; videoId?: number | null }) => {
      if (
        !shouldSuspendPlaybackForWatch({
          playingStreamUrl: streamRef.current?.url,
          playingVideoId: currentRef.current?.id,
          nextStreamUrl: next.streamUrl,
          nextVideoId: next.videoId,
        })
      ) {
        return;
      }
      setMediaSuspended(true);
    },
    []
  );

  const queueRef = useRef(queue);
  queueRef.current = queue;

  // A related library video, or the channel's next part (maybe not downloaded).
  const [upNext, setUpNext] = useState<QueueEntry | null>(null);
  const [upNextSeconds, setUpNextSeconds] = useState<number | null>(null);
  const upNextTimer = useRef<number | null>(null);

  const clearUpNext = useCallback(() => {
    if (upNextTimer.current !== null) {
      window.clearInterval(upNextTimer.current);
      upNextTimer.current = null;
    }
    setUpNext(null);
    setUpNextSeconds(null);
  }, []);

  useEffect(() => {
    clearUpNext();
  }, [current?.id, stream?.url, clearUpNext]);

  // Turning autoplay off mid-countdown cancels the overlay.
  useEffect(() => {
    if (!settings.autoplayRelated && !settings.autoplayNextPart) clearUpNext();
  }, [settings.autoplayRelated, settings.autoplayNextPart, clearUpNext]);

  const playSuggested = useCallback(
    (video: QueueEntry) => {
      clearUpNext();
      if (isQueuedStream(video)) {
        // Not downloaded (or only known by its link): the watch page plays it.
        navigate(video.href);
        return;
      }
      setStream(null);
      setMediaSuspended(false);
      libraryPosRef.current = 0;
      setCurrent(video);
      setQueue((q) => withoutVideo(q, video.id));
      navigate(`/watch/${video.id}`);
    },
    [clearUpNext, navigate]
  );

  const startUpNextCountdown = useCallback(
    (video: QueueEntry) => {
      clearUpNext();
      setUpNext(video);
      setUpNextSeconds(8);
      upNextTimer.current = window.setInterval(() => {
        setUpNextSeconds((s) => {
          if (s == null || s <= 1) {
            if (upNextTimer.current !== null) {
              window.clearInterval(upNextTimer.current);
              upNextTimer.current = null;
            }
            playSuggested(video);
            return null;
          }
          return s - 1;
        });
      }, 1000);
    },
    [clearUpNext, playSuggested]
  );

  const advance = useCallback(() => {
    const [next, ...rest] = queueRef.current;
    if (!next) return;
    setQueue(rest);
    if (isQueuedStream(next)) {
      // The watch page loads it and starts playback, as when its card is opened.
      navigate(next.href);
      return;
    }
    setStream(null);
    setMediaSuspended(false);
    setCurrent(next);
    navigate(`/watch/${next.id}`);
  }, [navigate]);

  // Reset saved progress when a video finishes so it leaves Continue watching.
  // Queue advances immediately; otherwise optionally show related up-next.
  const handleEnded = useCallback(() => {
    if (stream) {
      // A not-downloaded video saves no progress and has no related up-next,
      // but the queue still moves on.
      if (queueRef.current.length > 0) advance();
      return;
    }
    if (current) {
      progressSaver.finish(current.id);
      recentWatchedRef.current = [
        current.id,
        ...recentWatchedRef.current.filter((id) => id !== current.id),
      ].slice(0, 12);
    }
    if (queueRef.current.length > 0) {
      advance();
      return;
    }
    if (!current) return;
    const endedId = current.id;
    const exclude = new Set(recentWatchedRef.current);
    exclude.add(endedId);
    const playRelated = () => {
      if (!settings.autoplayRelated) return;
      api
        .getRelatedVideos(endedId, 12)
        .then((rows) => {
          if (queueRef.current.length > 0) return;
          const next = rows.find((v) => !exclude.has(v.id));
          if (next) startUpNextCountdown(next);
        })
        .catch(() => undefined);
    };
    if (!settings.autoplayNextPart) {
      playRelated();
      return;
    }
    // The channel's next upload first, when it clearly continues the series;
    // otherwise a related video as before.
    api
      .getNextPart(endedId)
      .then(({ entry }) => {
        if (queueRef.current.length > 0) return;
        const href = entry ? watchHref(entry, entry.channel ?? "") : null;
        if (
          !entry ||
          !href ||
          (entry.video_id != null && exclude.has(entry.video_id))
        ) {
          playRelated();
          return;
        }
        startUpNextCountdown({
          queue_kind: "stream",
          url: entry.url,
          href,
          title: entry.title || "Untitled",
          channel: entry.channel ?? null,
          thumbnail: youtubeThumbnailUrl(entry.id, entry.thumbnail_url),
          duration: entry.duration ?? null,
        });
      })
      .catch(playRelated);
  }, [
    current,
    stream,
    progressSaver,
    advance,
    startUpNextCountdown,
    settings.autoplayRelated,
    settings.autoplayNextPart,
  ]);

  const registerDock = useCallback((el: HTMLElement | null) => setDock(el), []);

  const libraryChapters = resolveLibraryChapters(
    current ?? { description: null }
  );
  const sponsorSegments = useSponsorBlock(
    current?.source_url ?? null,
    current?.file_path ?? "",
    settings.sponsorBlockEnabled && !stream,
    enabledSponsorBlockCategories(settings.sponsorBlockCategories)
  );

  const updateCurrentVideo = useCallback((video: Video) => {
    setCurrent((prev) =>
      prev?.id === video.id ? withPlayingPosition(prev, video) : prev
    );
  }, []);

  // Kept apart from `stream` so a later playStream() for the same stream
  // (e.g. a changed channel param) cannot overwrite it.
  const [streamChaptersOverride, setStreamChaptersOverride] = useState<{
    url: string;
    chapters: Chapter[];
  } | null>(null);
  const setStreamChapters = useCallback((url: string, chapters: Chapter[]) => {
    setStreamChaptersOverride((prev) =>
      prev?.url === url && prev.chapters === chapters ? prev : { url, chapters }
    );
  }, []);

  const refreshCurrentVideo = useCallback(() => {
    if (!current) return;
    api
      .getVideo(current.id)
      .then(updateCurrentVideo)
      .catch(() => undefined);
  }, [current, updateCurrentVideo]);

  const pollCurrentVideo =
    !!current &&
    !stream &&
    (!!current.subtitles_pending ||
      !!current.processing_chapters ||
      !!current.processing_summary);

  useEffect(() => {
    if (!pollCurrentVideo) return;
    const timer = window.setInterval(refreshCurrentVideo, 3000);
    return () => window.clearInterval(timer);
  }, [pollCurrentVideo, refreshCurrentVideo]);

  const session = useMemo<PlaybackSession>(
    () => ({ current, stream, queue, mode, miniPlayerActive }),
    [current, stream, queue, mode, miniPlayerActive]
  );
  const layout = useMemo<PlaybackLayout>(
    () => ({
      miniPlayerRect,
      miniPlayerCornerAnchor: miniCornerAnchor,
      activeStreamQuality,
      videoFrameInset,
    }),
    [miniPlayerRect, miniCornerAnchor, activeStreamQuality, videoFrameInset]
  );
  const actions = useMemo<PlaybackActions>(
    () => ({
      setMode,
      playVideo,
      playStream,
      getStreamPosition,
      getCurrentPosition,
      addToQueue,
      playNext,
      removeFromQueue,
      reorderQueue,
      clearQueue,
      close,
      suspendPlaybackMedia,
      registerDock,
      updateCurrentVideo,
      setStreamChapters,
    }),
    [
      setMode,
      playVideo,
      playStream,
      getStreamPosition,
      getCurrentPosition,
      addToQueue,
      playNext,
      removeFromQueue,
      reorderQueue,
      clearQueue,
      close,
      suspendPlaybackMedia,
      registerDock,
      updateCurrentVideo,
      setStreamChapters,
    ]
  );

  const handleMiniResize = useCallback(
    (width: number, origin: { left: number; top: number; height: number }) => {
      const host = hostRef.current;
      const height = origin.height || width * (9 / 16);
      if (host) host.style.width = `${width}px`;
      setMiniWidth(width);
      // Still corner-anchored: only the width changes. CSS right/bottom keep
      // the frame in the corner through both this resize and window resizes.
      if (!miniPosLiveRef.current) {
        if (host) {
          applyMiniHostInsets(
            host,
            miniPlayerHostInsets(null, { width, height }, isMobile)
          );
          const next = miniRectFromHost(host);
          if (next) setMiniPlayerRect(next);
        }
        return;
      }
      const clamped = clampMiniPos(origin.left, origin.top, width, height);
      if (host) {
        applyMiniHostInsets(
          host,
          miniPlayerHostInsets(clamped, { width, height }, isMobile)
        );
      }
      miniPosLiveRef.current = clamped;
      setMiniPos(clamped);
      setMiniPlayerRect({
        left: clamped.left,
        top: clamped.top,
        width,
        height,
        right: clamped.left + width,
        bottom: clamped.top + height,
      });
    },
    [setMiniWidth, setMiniPos, isMobile]
  );

  const handleMiniMove = useCallback(
    (left: number, top: number) => {
      const host = hostRef.current;
      if (!host) return;
      const width = host.offsetWidth || miniWidth || DEFAULT_MINI_WIDTH_DESKTOP;
      const height = host.offsetHeight || width * (9 / 16);
      const clamped = clampMiniPos(left, top, width, height);
      applyMiniHostInsets(
        host,
        miniPlayerHostInsets(clamped, { width, height }, isMobile)
      );
      miniPosLiveRef.current = clamped;
      setMiniCornerAnchor(false);
      setMiniPlayerRect({
        left: clamped.left,
        top: clamped.top,
        width,
        height,
        right: clamped.left + width,
        bottom: clamped.top + height,
      });
    },
    [miniWidth, isMobile]
  );

  const handleMiniMoveEnd = useCallback(() => {
    if (miniPosLiveRef.current) {
      setMiniPos(miniPosLiveRef.current);
    }
  }, [setMiniPos]);

  const libraryRendition = useLibraryRendition(
    current,
    settings.downloadVideoCodec,
    updateCurrentVideo
  );

  // Query params bust the browser cache when the stored file is replaced.
  const streamSrc =
    current == null || libraryRendition.rendition == null
      ? ""
      : libraryRendition.rendition === "compat"
        ? `${streamUrl(current.id, "compat")}&s=${current.compat_size ?? 0}`
        : `${streamUrl(current.id)}?s=${current.file_size ?? 0}&h=${current.height_px ?? 0}`;
  const compatBlocked =
    current != null &&
    !libraryRendition.checking &&
    !libraryRendition.safariPreparing &&
    libraryRendition.rendition == null;

  // Distinct keys so DASH (Shaka/MSE) does not reuse the same VideoPlayer
  // instance as library progressive playback, or as a different preview URL.
  // Updating src in place leaves MediaSource attached and hangs on a spinner.
  const playerPortal =
    current != null ? (
      <VideoPlayer
        key="library"
        src={streamSrc}
        videoId={current.id}
        mimeType={
          libraryRendition.rendition === "compat"
            ? "video/mp4"
            : mimeFromPath(current.file_path)
        }
        blockingOverlay={
          libraryRendition.safariPreparing ? (
            <SafariPrepGate prep={libraryRendition.safariPrep} isMini={!dock} />
          ) : compatBlocked ? (
            <CompatGate
              video={current}
              compat={libraryRendition.compat}
              originalFailed={libraryRendition.originalFailed}
              isMini={!dock}
              onRequest={libraryRendition.requestCompat}
              onForceOriginal={libraryRendition.forceOriginal}
              copyCap={settings.compatCopyResolution === "source" ? 2160 : 1080}
            />
          ) : undefined
        }
        onSourceError={libraryRendition.handleOriginalError}
        poster={thumbnailUrl(current)}
        mode={effectiveMode}
        onModeChange={setMode}
        variant={dock ? "full" : "mini"}
        title={current.title}
        tracks={dedupeSubtitleTracks(current.subtitles).map((t) => ({
          lang: t.lang,
          src: subtitleUrl(current.id, t.lang),
        }))}
        onEnded={handleEnded}
        onExpand={() => navigate(`/watch/${current.id}`)}
        onClose={close}
        subtitleSize={settings.subtitleSize}
        subtitleLeft={settings.subtitleLeft}
        subtitleOffset={settings.subtitleOffset}
        onSubtitlePositionChange={(left, offset) =>
          updateSettings({ subtitleLeft: left, subtitleOffset: offset })
        }
        defaultRate={settings.defaultPlaybackRate}
        volume={settings.volume}
        onVolumeChange={(v) => updateSettings({ volume: v })}
        initialPosition={current.last_position_sec}
        onProgress={(sec) => {
          libraryPosRef.current = sec;
          progressSaver.report(current.id, sec, current.duration_sec);
        }}
        chapters={libraryChapters}
        sponsorSegments={sponsorSegments}
        sponsorShowNotice={settings.sponsorBlockShowNotice}
        sponsorSkipMode={settings.sponsorBlockSkipMode}
        subtitlesPending={current.subtitles_pending}
        onSubtitlesRefresh={refreshCurrentVideo}
        miniWidth={miniWidth}
        onMiniResize={handleMiniResize}
        onMiniMove={handleMiniMove}
        onMiniMoveEnd={handleMiniMoveEnd}
        upNext={
          upNext
            ? {
                title: upNext.title,
                channel: upNext.channel,
                poster: isQueuedStream(upNext)
                  ? upNext.thumbnail
                  : thumbnailUrl(upNext),
                note: isQueuedStream(upNext)
                  ? upNext.href.startsWith("/watch?")
                    ? "Next part · not downloaded"
                    : "Next part"
                  : null,
                seconds: upNextSeconds ?? 0,
              }
            : null
        }
        onCancelUpNext={clearUpNext}
        onPlayUpNext={upNext ? () => playSuggested(upNext) : undefined}
        autoplayRelated={settings.autoplayRelated}
        singleKeyShortcuts={settings.playerShortcuts}
        onAutoplayRelatedChange={(enabled) =>
          updateSettings({ autoplayRelated: enabled })
        }
        onActiveQualityChange={setActiveStreamQuality}
        onFrameInsetChange={setVideoFrameInset}
        mediaSuspended={mediaSuspended}
      />
    ) : stream != null ? (
      <VideoPlayer
        key={`stream:${stream.url}`}
        src={
          stream.liveVideoId
            ? liveMasterUrl(stream.liveVideoId)
            : previewManifestUrl(stream.url)
        }
        streamType="dash"
        live={Boolean(stream.liveVideoId)}
        progressiveFallbackSrc={previewStreamUrl(stream.url)}
        mimeType={
          stream.liveVideoId
            ? "application/vnd.apple.mpegurl"
            : "application/dash+xml"
        }
        poster={stream.poster}
        mode={effectiveMode}
        onModeChange={setMode}
        variant={dock ? "full" : "mini"}
        title={stream.title}
        tracks={dedupeSubtitleTracks(stream.subtitles ?? []).map((t) => ({
          lang: t.lang,
          src: previewSubtitleUrl(stream.url, t.lang),
        }))}
        onEnded={handleEnded}
        onExpand={() => navigate(streamExpandPath(stream))}
        onClose={close}
        subtitleSize={settings.subtitleSize}
        subtitleLeft={settings.subtitleLeft}
        subtitleOffset={settings.subtitleOffset}
        onSubtitlePositionChange={(left, offset) =>
          updateSettings({ subtitleLeft: left, subtitleOffset: offset })
        }
        defaultRate={settings.defaultPlaybackRate}
        volume={settings.volume}
        onVolumeChange={(v) => updateSettings({ volume: v })}
        onProgress={(sec) => {
          streamPosRef.current = sec;
        }}
        chapters={
          streamChaptersOverride?.url === stream.url
            ? streamChaptersOverride.chapters
            : stream.chapters
        }
        miniWidth={miniWidth}
        onMiniResize={handleMiniResize}
        onMiniMove={handleMiniMove}
        onMiniMoveEnd={handleMiniMoveEnd}
        singleKeyShortcuts={settings.playerShortcuts}
        onActiveQualityChange={setActiveStreamQuality}
        onFrameInsetChange={setVideoFrameInset}
        mediaSuspended={mediaSuspended}
      />
    ) : null;

  return (
    <ActionsCtx.Provider value={actions}>
      <SessionCtx.Provider value={session}>
        <LayoutCtx.Provider value={layout}>
          {children}
          {playerPortal && createPortal(playerPortal, hostRef.current)}
        </LayoutCtx.Provider>
      </SessionCtx.Provider>
    </ActionsCtx.Provider>
  );
}

function useRequired<T>(value: T | null, hook: string): T {
  if (!value) throw new Error(`${hook} must be used within PlaybackProvider`);
  return value;
}

/** Stable: never changes, so reading it never causes a re-render. */
export function usePlaybackActions(): PlaybackActions {
  return useRequired(useContext(ActionsCtx), "usePlaybackActions");
}

export function usePlaybackSession(): PlaybackSession {
  return useRequired(useContext(SessionCtx), "usePlaybackSession");
}

export function usePlaybackLayout(): PlaybackLayout {
  return useRequired(useContext(LayoutCtx), "usePlaybackLayout");
}
