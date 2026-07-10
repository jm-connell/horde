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
import { api, streamUrl, subtitleUrl, thumbnailUrl } from "../api";
import VideoPlayer, { type ViewMode } from "../components/VideoPlayer";
import { loadSettings, useSettings } from "../hooks/useSettings";
import { useIsMobile } from "../hooks/useIsMobile";
import { useSponsorBlock } from "../hooks/useSponsorBlock";
import { dedupeSubtitleTracks, parseChapters } from "../utils";
import type { Video } from "../types";

interface PlaybackValue {
  current: Video | null;
  queue: Video[];
  mode: ViewMode;
  setMode: (mode: ViewMode) => void;
  playVideo: (video: Video, opts?: { queue?: Video[] }) => void;
  addToQueue: (video: Video) => void;
  playNext: (video: Video) => void;
  removeFromQueue: (id: number) => void;
  reorderQueue: (from: number, to: number) => void;
  clearQueue: () => void;
  close: () => void;
  registerDock: (el: HTMLElement | null) => void;
  /** True when the floating mini-player is showing (browsing away from Watch). */
  miniPlayerActive: boolean;
}

const Ctx = createContext<PlaybackValue | null>(null);

const QUEUE_KEY = "horde.queue";
const MINI_WIDTH_KEY = "horde.mini-width";
const DEFAULT_MINI_WIDTH_MOBILE = 224;
const DEFAULT_MINI_WIDTH_DESKTOP = 704;

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

export function PlaybackProvider({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  const [settings, updateSettings] = useSettings();
  const isMobile = useIsMobile();
  const [current, setCurrent] = useState<Video | null>(null);
  const [queue, setQueue] = useState<Video[]>(loadQueue);
  const [dock, setDock] = useState<HTMLElement | null>(null);
  const [mode, setModeState] = useState<ViewMode>(
    () => loadSettings().playbackMode
  );
  const [miniWidth, setMiniWidthState] = useState<number | null>(loadMiniWidth);

  const setMiniWidth = useCallback((w: number | null) => {
    setMiniWidthState(w);
    try {
      if (w == null) localStorage.removeItem(MINI_WIDTH_KEY);
      else localStorage.setItem(MINI_WIDTH_KEY, String(w));
    } catch {
      /* ignore */
    }
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

  // Persist watch position at most once every 5s while playing.
  // Skip saving near the end (>=90%) — treat as finished (restart next time).
  const progressTimer = useRef<number | null>(null);
  const saveProgress = useCallback(
    (id: number, sec: number, durationSec?: number | null) => {
      if (
        durationSec
        && durationSec > 0
        && sec > 0
        && sec >= durationSec * 0.9
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
    if (!isMobile && mode === "windowed" && current) {
      document.body.appendChild(host);
      host.className = "fixed inset-0 z-50";
      host.style.width = "";
      host.style.maxWidth = "";
    } else if (dock) {
      dock.appendChild(host);
      host.className = "w-full";
      host.style.width = "";
      host.style.maxWidth = "";
    } else if (current) {
      document.body.appendChild(host);
      const defaultWidth = isMobile
        ? DEFAULT_MINI_WIDTH_MOBILE
        : DEFAULT_MINI_WIDTH_DESKTOP;
      const width = miniWidth ?? defaultWidth;
      host.className = isMobile
        ? "fixed bottom-3 right-3 z-40 overflow-hidden rounded-xl shadow-2xl ring-1 ring-ink-700"
        : "fixed bottom-4 right-4 z-40 overflow-hidden rounded-xl shadow-2xl ring-1 ring-ink-700";
      host.style.width = `${width}px`;
      host.style.maxWidth = isMobile ? "70vw" : "calc(100vw - 2rem)";
    } else {
      host.className = "hidden";
      host.style.width = "";
      host.style.maxWidth = "";
    }
  }, [dock, current, isMobile, mode, miniWidth]);

  // Hide page scroll while windowed fullscreen is active.
  useEffect(() => {
    if (!isMobile && mode === "windowed" && current) {
      document.body.style.overflow = "hidden";
      return () => {
        document.body.style.overflow = "";
      };
    }
  }, [isMobile, mode, current]);

  useEffect(() => {
    const host = hostRef.current!;
    return () => {
      host.remove();
    };
  }, []);

  const playVideo = useCallback(
    (video: Video, opts?: { queue?: Video[] }) => {
      setCurrent(video);
      if (opts?.queue) {
        setQueue(opts.queue.filter((v) => v.id !== video.id));
      } else {
        setQueue((q) => q.filter((v) => v.id !== video.id));
      }
    },
    []
  );

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
      if (from === to || from < 0 || to < 0 || from >= q.length || to >= q.length) {
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
    setDock(null);
  }, []);

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
  }, [current?.id, clearUpNext]);

  // Turning autoplay off mid-countdown cancels the overlay.
  useEffect(() => {
    if (!settings.autoplayRelated) clearUpNext();
  }, [settings.autoplayRelated, clearUpNext]);

  const playSuggested = useCallback(
    (video: Video) => {
      clearUpNext();
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
      setCurrent(next);
      navigate(`/watch/${next.id}`);
      return rest;
    });
  }, [navigate]);

  // Reset saved progress when a video finishes so it leaves Continue watching.
  // Queue advances immediately; otherwise optionally show related up-next.
  const handleEnded = useCallback(() => {
    if (current) api.saveProgress(current.id, 0).catch(() => undefined);
    if (queueRef.current.length > 0) {
      advance();
      return;
    }
    if (!current || !settings.autoplayRelated) return;
    const endedId = current.id;
    api
      .getRelatedVideos(endedId, 1)
      .then((rows) => {
        if (queueRef.current.length > 0) return;
        const next = rows[0];
        if (next) startUpNextCountdown(next);
      })
      .catch(() => undefined);
  }, [current, advance, startUpNextCountdown, settings.autoplayRelated]);

  const registerDock = useCallback((el: HTMLElement | null) => setDock(el), []);

  const miniPlayerActive = Boolean(
    current && !dock && !( !isMobile && mode === "windowed")
  );

  const chapters = parseChapters(current?.description ?? null);
  const sponsorSegments = useSponsorBlock(
    current?.source_url ?? null,
    current?.file_path ?? "",
    settings.sponsorBlockEnabled
  );

  const refreshCurrentVideo = useCallback(() => {
    if (!current) return;
    api.getVideo(current.id).then(setCurrent).catch(() => undefined);
  }, [current]);

  useEffect(() => {
    if (!current?.subtitles_pending) return;
    const timer = window.setInterval(refreshCurrentVideo, 3000);
    return () => window.clearInterval(timer);
  }, [current?.id, current?.subtitles_pending, refreshCurrentVideo]);

  const value: PlaybackValue = {
    current,
    queue,
    mode,
    setMode,
    playVideo,
    addToQueue,
    playNext,
    removeFromQueue,
    reorderQueue,
    clearQueue,
    close,
    registerDock,
    miniPlayerActive,
  };

  return (
    <Ctx.Provider value={value}>
      {children}
      {current &&
        createPortal(
          <VideoPlayer
            src={streamUrl(current.id)}
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
            onProgress={(sec) =>
              saveProgress(current.id, sec, current.duration_sec)
            }
            chapters={chapters}
            sponsorSegments={sponsorSegments}
            sponsorShowNotice={settings.sponsorBlockShowNotice}
            subtitlesPending={current.subtitles_pending}
            onSubtitlesRefresh={refreshCurrentVideo}
            miniWidth={miniWidth}
            onMiniResize={setMiniWidth}
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
            onPlayUpNext={
              upNext ? () => playSuggested(upNext) : undefined
            }
            autoplayRelated={settings.autoplayRelated}
            onAutoplayRelatedChange={(enabled) =>
              updateSettings({ autoplayRelated: enabled })
            }
          />,
          hostRef.current
        )}
    </Ctx.Provider>
  );
}

export function usePlayback(): PlaybackValue {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("usePlayback must be used within PlaybackProvider");
  return ctx;
}
