import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import {
  api,
  previewManifestUrl,
  streamUrl,
  subtitleUrl,
  thumbnailUrl,
} from "../api";
import VideoPlayer, { type ViewMode } from "../components/VideoPlayer";
import { loadSettings, useSettings } from "../hooks/useSettings";
import { useIsMobile } from "../hooks/useIsMobile";
import { useSponsorBlock } from "../hooks/useSponsorBlock";
import {
  dedupeSubtitleTracks,
  parseChapters,
  type Chapter,
} from "../utils";
import type { Video } from "../types";

export interface PreviewSession {
  url: string;
  title: string;
  channel: string | null;
  poster: string | null;
  chapters: Chapter[];
  sourceUrl?: string | null;
  /** Channel query for expand / back navigation. */
  channelParam?: string | null;
}

export type MiniPlayerRect = {
  left: number;
  top: number;
  width: number;
  height: number;
  right: number;
  bottom: number;
};

interface PlaybackValue {
  current: Video | null;
  preview: PreviewSession | null;
  queue: Video[];
  mode: ViewMode;
  setMode: (mode: ViewMode) => void;
  playVideo: (video: Video, opts?: { queue?: Video[] }) => void;
  playPreview: (session: PreviewSession) => void;
  /** Latest preview playback position (seconds). */
  getPreviewPosition: () => number;
  /** Latest library playback position (seconds). */
  getCurrentPosition: () => number;
  addToQueue: (video: Video) => void;
  playNext: (video: Video) => void;
  removeFromQueue: (id: number) => void;
  reorderQueue: (from: number, to: number) => void;
  clearQueue: () => void;
  close: () => void;
  registerDock: (el: HTMLElement | null) => void;
  /** True when the floating mini-player is showing (browsing away from Watch/Preview). */
  miniPlayerActive: boolean;
  /** Live bounds of the floating mini-player (null when not mini). */
  miniPlayerRect: MiniPlayerRect | null;
}

const Ctx = createContext<PlaybackValue | null>(null);

const QUEUE_KEY = "horde.queue";
const MINI_WIDTH_KEY = "horde.mini-width";
const DEFAULT_MINI_WIDTH_MOBILE = 224;
const DEFAULT_MINI_WIDTH_DESKTOP = 704;

type MiniPos = { left: number; top: number };

function loadMiniWidth(): number | null {
  try {
    const raw = localStorage.getItem(MINI_WIDTH_KEY);
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 160 && n <= 960 ? n : null;
  } catch {
    return null;
  }
}

function clampMiniPos(
  left: number,
  top: number,
  width: number,
  height: number
): MiniPos {
  const margin = 8;
  const maxLeft = Math.max(margin, window.innerWidth - width - margin);
  const maxTop = Math.max(margin, window.innerHeight - height - margin);
  return {
    left: Math.min(maxLeft, Math.max(margin, left)),
    top: Math.min(maxTop, Math.max(margin, top)),
  };
}

function mimeFromPath(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "mp4":
      return "video/mp4";
    case "webm":
      return "video/webm";
    case "mkv":
      return "video/x-matroska";
    default:
      return "video/mp4";
  }
}

function loadQueue(): Video[] {
  try {
    const raw = sessionStorage.getItem(QUEUE_KEY);
    return raw ? (JSON.parse(raw) as Video[]) : [];
  } catch {
    return [];
  }
}

function previewExpandPath(session: PreviewSession): string {
  const qs = new URLSearchParams();
  qs.set("url", session.url);
  const channel = session.channelParam || session.channel;
  if (channel) qs.set("channel", channel);
  return `/preview?${qs.toString()}`;
}

export function PlaybackProvider({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  const [settings, updateSettings] = useSettings();
  const isMobile = useIsMobile();
  const [current, setCurrent] = useState<Video | null>(null);
  const [preview, setPreview] = useState<PreviewSession | null>(null);
  const [queue, setQueue] = useState<Video[]>(loadQueue);
  const [dock, setDock] = useState<HTMLElement | null>(null);
  const [mode, setModeState] = useState<ViewMode>(
    () => loadSettings().playbackMode
  );
  const [miniWidth, setMiniWidthState] = useState<number | null>(loadMiniWidth);
  // Session-only; always starts bottom-right when a miniplayer opens after close.
  const [miniPos, setMiniPosState] = useState<MiniPos | null>(null);
  const miniPosLiveRef = useRef<MiniPos | null>(null);
  const previewPosRef = useRef(0);
  const libraryPosRef = useRef(0);
  const recentWatchedRef = useRef<number[]>([]);
  const [miniPlayerRect, setMiniPlayerRect] = useState<MiniPlayerRect | null>(
    null
  );

  useEffect(() => {
    try {
      localStorage.removeItem("horde.mini-pos");
    } catch {
      /* ignore */
    }
  }, []);

  const setMiniWidth = useCallback((w: number | null) => {
    setMiniWidthState(w);
    try {
      if (w == null) localStorage.removeItem(MINI_WIDTH_KEY);
      else localStorage.setItem(MINI_WIDTH_KEY, String(w));
    } catch {
      /* ignore */
    }
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

  const activeSession = Boolean(current || preview);

  // Persist watch position at most once every 5s while playing.
  // Skip saving near the end (>=90%) — treat as finished (restart next time).
  const progressTimer = useRef<number | null>(null);
  const saveProgress = useCallback(
    (id: number, sec: number, durationSec?: number | null) => {
      if (
        durationSec &&
        durationSec > 0 &&
        sec > 0 &&
        sec >= durationSec * 0.9
      ) {
        if (progressTimer.current !== null) return;
        progressTimer.current = window.setTimeout(() => {
          progressTimer.current = null;
        }, 5000);
        api.saveProgress(id, 0).catch(() => undefined);
        return;
      }
      if (progressTimer.current !== null) return;
      progressTimer.current = window.setTimeout(() => {
        progressTimer.current = null;
      }, 5000);
      // Resuming watch (≥30s) should bring the video back to Continue watching.
      if (sec >= 30) {
        import("../hooks/useContinueWatchingDismiss").then((m) =>
          m.undismissContinueWatching(id)
        );
      }
      api.saveProgress(id, sec).catch(() => undefined);
    },
    []
  );

  useEffect(() => {
    sessionStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  }, [queue]);

  // Move the persistent player node into the watch dock, body (windowed), or a
  // floating mini-player while browsing. Using appendChild (not portal
  // re-targeting) keeps the <video> element alive so playback never restarts.
  useEffect(() => {
    const host = hostRef.current!;
    if (!isMobile && mode === "windowed" && activeSession) {
      document.body.appendChild(host);
      host.className = "fixed inset-0 z-50";
      host.style.width = "";
      host.style.maxWidth = "";
      host.style.left = "";
      host.style.top = "";
      host.style.right = "";
      host.style.bottom = "";
    } else if (dock && activeSession) {
      dock.appendChild(host);
      host.className = "h-full w-full";
      host.style.width = "";
      host.style.maxWidth = "";
      host.style.left = "";
      host.style.top = "";
      host.style.right = "";
      host.style.bottom = "";
      host.style.height = "";
    } else if (activeSession) {
      document.body.appendChild(host);
      const defaultWidth = isMobile
        ? DEFAULT_MINI_WIDTH_MOBILE
        : DEFAULT_MINI_WIDTH_DESKTOP;
      const width = miniWidth ?? defaultWidth;
      host.className =
        "fixed z-40 overflow-hidden rounded-xl shadow-2xl ring-1 ring-ink-700";
      host.style.width = `${width}px`;
      host.style.maxWidth = isMobile ? "70vw" : "calc(100vw - 2rem)";
      host.style.right = "";
      host.style.bottom = "";
      const height = host.getBoundingClientRect().height || width * (9 / 16);
      if (miniPos) {
        const clamped = clampMiniPos(miniPos.left, miniPos.top, width, height);
        host.style.left = `${clamped.left}px`;
        host.style.top = `${clamped.top}px`;
      } else {
        const margin = isMobile ? 12 : 16;
        host.style.left = `${Math.max(margin, window.innerWidth - width - margin)}px`;
        host.style.top = `${Math.max(margin, window.innerHeight - height - margin)}px`;
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
  }, [dock, current, preview, activeSession, isMobile, mode, miniWidth, miniPos]);

  const miniPlayerActive = Boolean(
    activeSession && !dock && !( !isMobile && mode === "windowed")
  );

  // Publish mini-player bounds so floating UI (download panel / queue) can avoid it.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !miniPlayerActive) {
      setMiniPlayerRect(null);
      return;
    }

    const publish = () => {
      const r = host.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      setMiniPlayerRect({
        left: r.left,
        top: r.top,
        width: r.width,
        height: r.height,
        right: r.right,
        bottom: r.bottom,
      });
    };

    publish();
    const ro = new ResizeObserver(publish);
    ro.observe(host);
    window.addEventListener("resize", publish);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", publish);
    };
  }, [miniPlayerActive, miniWidth, miniPos, current?.id, preview?.url]);

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
    (video: Video, opts?: { queue?: Video[] }) => {
      setCurrent((prev) => {
        if (prev?.id != null && prev.id !== video.id) {
          recentWatchedRef.current = [
            prev.id,
            ...recentWatchedRef.current.filter((id) => id !== prev.id),
          ].slice(0, 12);
        }
        return video;
      });
      setPreview(null);
      previewPosRef.current = 0;
      libraryPosRef.current = video.last_position_sec || 0;
      if (opts?.queue) {
        setQueue(opts.queue.filter((v) => v.id !== video.id));
      } else {
        setQueue((q) => q.filter((v) => v.id !== video.id));
      }
    },
    []
  );

  const playPreview = useCallback((session: PreviewSession) => {
    setCurrent(null);
    previewPosRef.current = 0;
    libraryPosRef.current = 0;
    setPreview(session);
  }, []);

  const getPreviewPosition = useCallback(() => previewPosRef.current, []);
  const getCurrentPosition = useCallback(() => libraryPosRef.current, []);

  const addToQueue = useCallback((video: Video) => {
    setQueue((q) => (q.some((v) => v.id === video.id) ? q : [...q, video]));
  }, []);

  const playNext = useCallback((video: Video) => {
    setQueue((q) => [video, ...q.filter((v) => v.id !== video.id)]);
  }, []);

  const removeFromQueue = useCallback((id: number) => {
    setQueue((q) => q.filter((v) => v.id !== id));
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
    setPreview(null);
    previewPosRef.current = 0;
    libraryPosRef.current = 0;
    setDock(null);
    setMiniPos(null);
  }, [setMiniPos]);

  const queueRef = useRef(queue);
  queueRef.current = queue;

  const [upNext, setUpNext] = useState<Video | null>(null);
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
  }, [current?.id, preview?.url, clearUpNext]);

  // Turning autoplay off mid-countdown cancels the overlay.
  useEffect(() => {
    if (!settings.autoplayRelated) clearUpNext();
  }, [settings.autoplayRelated, clearUpNext]);

  const playSuggested = useCallback(
    (video: Video) => {
      clearUpNext();
      setPreview(null);
      libraryPosRef.current = 0;
      setCurrent(video);
      setQueue((q) => q.filter((v) => v.id !== video.id));
      navigate(`/watch/${video.id}`);
    },
    [clearUpNext, navigate]
  );

  const startUpNextCountdown = useCallback(
    (video: Video) => {
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
    setQueue((q) => {
      if (q.length === 0) return q;
      const [next, ...rest] = q;
      setPreview(null);
      setCurrent(next);
      navigate(`/watch/${next.id}`);
      return rest;
    });
  }, [navigate]);

  // Reset saved progress when a video finishes so it leaves Continue watching.
  // Queue advances immediately; otherwise optionally show related up-next.
  const handleEnded = useCallback(() => {
    if (preview) return;
    if (current) {
      api.saveProgress(current.id, 0).catch(() => undefined);
      recentWatchedRef.current = [
        current.id,
        ...recentWatchedRef.current.filter((id) => id !== current.id),
      ].slice(0, 12);
    }
    if (queueRef.current.length > 0) {
      advance();
      return;
    }
    if (!current || !settings.autoplayRelated) return;
    const endedId = current.id;
    const exclude = new Set(recentWatchedRef.current);
    exclude.add(endedId);
    api
      .getRelatedVideos(endedId, 12)
      .then((rows) => {
        if (queueRef.current.length > 0) return;
        const next = rows.find((v) => !exclude.has(v.id));
        if (next) startUpNextCountdown(next);
      })
      .catch(() => undefined);
  }, [
    current,
    preview,
    advance,
    startUpNextCountdown,
    settings.autoplayRelated,
  ]);

  const registerDock = useCallback((el: HTMLElement | null) => setDock(el), []);

  const libraryChapters = parseChapters(current?.description ?? null);
  const sponsorSegments = useSponsorBlock(
    current?.source_url ?? null,
    current?.file_path ?? "",
    settings.sponsorBlockEnabled && !preview
  );

  const refreshCurrentVideo = useCallback(() => {
    if (!current) return;
    api.getVideo(current.id).then(setCurrent).catch(() => undefined);
  }, [current]);

  useEffect(() => {
    if (!current?.subtitles_pending || preview) return;
    const timer = window.setInterval(refreshCurrentVideo, 3000);
    return () => window.clearInterval(timer);
  }, [current?.id, current?.subtitles_pending, preview, refreshCurrentVideo]);

  const value: PlaybackValue = {
    current,
    preview,
    queue,
    mode,
    setMode,
    playVideo,
    playPreview,
    getPreviewPosition,
    getCurrentPosition,
    addToQueue,
    playNext,
    removeFromQueue,
    reorderQueue,
    clearQueue,
    close,
    registerDock,
    miniPlayerActive,
    miniPlayerRect,
  };

  const streamSrc =
    current != null
      ? `${streamUrl(current.id)}?s=${current.file_size ?? 0}&h=${current.height_px ?? 0}`
      : "";

  const playerPortal =
    current != null ? (
      <VideoPlayer
        src={streamSrc}
        videoId={current.id}
        mimeType={mimeFromPath(current.file_path)}
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
        subtitleOffset={settings.subtitleOffset}
        onSubtitleOffsetChange={(offset) =>
          updateSettings({ subtitleOffset: offset })
        }
        defaultRate={settings.defaultPlaybackRate}
        volume={settings.volume}
        onVolumeChange={(v) => updateSettings({ volume: v })}
        initialPosition={current.last_position_sec}
        onProgress={(sec) => {
          libraryPosRef.current = sec;
          saveProgress(current.id, sec, current.duration_sec);
        }}
        chapters={libraryChapters}
        sponsorSegments={sponsorSegments}
        sponsorShowNotice={settings.sponsorBlockShowNotice}
        subtitlesPending={current.subtitles_pending}
        onSubtitlesRefresh={refreshCurrentVideo}
        miniWidth={miniWidth}
        onMiniResize={setMiniWidth}
        onMiniMove={(left, top) => {
          const host = hostRef.current;
          if (!host) return;
          const width =
            host.offsetWidth || miniWidth || DEFAULT_MINI_WIDTH_DESKTOP;
          const height = host.offsetHeight || width * (9 / 16);
          const clamped = clampMiniPos(left, top, width, height);
          host.style.left = `${clamped.left}px`;
          host.style.top = `${clamped.top}px`;
          miniPosLiveRef.current = clamped;
          setMiniPlayerRect({
            left: clamped.left,
            top: clamped.top,
            width,
            height,
            right: clamped.left + width,
            bottom: clamped.top + height,
          });
        }}
        onMiniMoveEnd={() => {
          if (miniPosLiveRef.current) {
            setMiniPos(miniPosLiveRef.current);
          }
        }}
        upNext={
          upNext
            ? {
                title: upNext.title,
                channel: upNext.channel,
                poster: thumbnailUrl(upNext),
                seconds: upNextSeconds ?? 0,
              }
            : null
        }
        onCancelUpNext={clearUpNext}
        onPlayUpNext={upNext ? () => playSuggested(upNext) : undefined}
        autoplayRelated={settings.autoplayRelated}
        onAutoplayRelatedChange={(enabled) =>
          updateSettings({ autoplayRelated: enabled })
        }
      />
    ) : preview != null ? (
      <VideoPlayer
        src={previewManifestUrl(preview.url)}
        streamType="dash"
        mimeType="application/dash+xml"
        poster={preview.poster}
        mode={effectiveMode}
        onModeChange={setMode}
        variant={dock ? "full" : "mini"}
        title={preview.title}
        onEnded={handleEnded}
        onExpand={() => navigate(previewExpandPath(preview))}
        onClose={close}
        subtitleSize={settings.subtitleSize}
        subtitleOffset={settings.subtitleOffset}
        onSubtitleOffsetChange={(offset) =>
          updateSettings({ subtitleOffset: offset })
        }
        defaultRate={settings.defaultPlaybackRate}
        volume={settings.volume}
        onVolumeChange={(v) => updateSettings({ volume: v })}
        onProgress={(sec) => {
          previewPosRef.current = sec;
        }}
        chapters={preview.chapters}
        miniWidth={miniWidth}
        onMiniResize={setMiniWidth}
        onMiniMove={(left, top) => {
          const host = hostRef.current;
          if (!host) return;
          const width =
            host.offsetWidth || miniWidth || DEFAULT_MINI_WIDTH_DESKTOP;
          const height = host.offsetHeight || width * (9 / 16);
          const clamped = clampMiniPos(left, top, width, height);
          host.style.left = `${clamped.left}px`;
          host.style.top = `${clamped.top}px`;
          miniPosLiveRef.current = clamped;
          setMiniPlayerRect({
            left: clamped.left,
            top: clamped.top,
            width,
            height,
            right: clamped.left + width,
            bottom: clamped.top + height,
          });
        }}
        onMiniMoveEnd={() => {
          if (miniPosLiveRef.current) {
            setMiniPos(miniPosLiveRef.current);
          }
        }}
      />
    ) : null;

  return (
    <Ctx.Provider value={value}>
      {children}
      {playerPortal && createPortal(playerPortal, hostRef.current)}
    </Ctx.Provider>
  );
}

export function usePlayback(): PlaybackValue {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("usePlayback must be used within PlaybackProvider");
  return ctx;
}
