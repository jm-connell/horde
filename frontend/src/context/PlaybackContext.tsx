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
import { api, streamUrl, subtitleUrl } from "../api";
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
}

const Ctx = createContext<PlaybackValue | null>(null);

const QUEUE_KEY = "horde.queue";

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
  const progressTimer = useRef<number | null>(null);
  const saveProgress = useCallback((id: number, sec: number) => {
    if (progressTimer.current !== null) return;
    progressTimer.current = window.setTimeout(() => {
      progressTimer.current = null;
    }, 5000);
    api.saveProgress(id, sec).catch(() => undefined);
  }, []);

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
    } else if (dock) {
      dock.appendChild(host);
      host.className = "w-full";
    } else if (current) {
      document.body.appendChild(host);
      host.className = isMobile
        ? "fixed bottom-0 inset-x-0 z-40 overflow-hidden shadow-2xl ring-1 ring-ink-700"
        : "fixed bottom-4 right-4 z-40 w-[44rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl shadow-2xl ring-1 ring-ink-700";
    } else {
      host.className = "hidden";
    }
  }, [dock, current, isMobile, mode]);

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
  const handleEnded = useCallback(() => {
    if (current) api.saveProgress(current.id, 0).catch(() => undefined);
    advance();
  }, [current, advance]);

  const registerDock = useCallback((el: HTMLElement | null) => setDock(el), []);

  const chapters = parseChapters(current?.description ?? null);
  const sponsorSegments = useSponsorBlock(
    current?.source_url ?? null,
    current?.file_path ?? "",
    settings.sponsorBlockEnabled
  );

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
  };

  return (
    <Ctx.Provider value={value}>
      {children}
      {current &&
        createPortal(
          <VideoPlayer
            src={streamUrl(current.id)}
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
            onProgress={(sec) => saveProgress(current.id, sec)}
            chapters={chapters}
            sponsorSegments={sponsorSegments}
            sponsorShowNotice={settings.sponsorBlockShowNotice}
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
