import { useCallback, useEffect, useRef, useState } from "react";
import { formatDuration } from "../utils";
import type { SubtitleSize } from "../hooks/useSettings";
import { useIsMobile } from "../hooks/useIsMobile";

export type ViewMode = "standard" | "theater" | "windowed";

export interface SubtitleSource {
  lang: string;
  src: string;
}

const SPEED_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];
const CONTROLS_HIDE_DELAY_MS = 2500;

interface Props {
  src: string;
  mode: ViewMode;
  onModeChange: (mode: ViewMode) => void;
  tracks?: SubtitleSource[];
  onEnded?: () => void;
  variant?: "full" | "mini";
  title?: string;
  onExpand?: () => void;
  onClose?: () => void;
  subtitleSize?: SubtitleSize;
  subtitleOffset?: number;
  defaultRate?: number;
  volume?: number;
  onVolumeChange?: (volume: number) => void;
  initialPosition?: number;
  onProgress?: (sec: number) => void;
}

export default function VideoPlayer({
  src,
  mode,
  onModeChange,
  tracks = [],
  onEnded,
  variant = "full",
  title,
  onExpand,
  onClose,
  subtitleSize = "medium",
  subtitleOffset = 12,
  defaultRate = 1,
  volume: volumeProp,
  onVolumeChange,
  initialPosition = 0,
  onProgress,
}: Props) {
  const isMini = variant === "mini";
  const isMobile = useIsMobile();
  const videoRef = useRef<HTMLVideoElement>(null);
  const hideControlsTimer = useRef<number | null>(null);
  const controlsInteracting = useRef(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(volumeProp ?? 1);
  const [muted, setMuted] = useState(false);
  const [captionLang, setCaptionLang] = useState<string | null>(null);
  const [rate, setRate] = useState(defaultRate);
  const [showSpeed, setShowSpeed] = useState(false);
  // Remembers the user's chosen rate while "hold for 2x" is temporarily active.
  const heldRate = useRef<number | null>(null);
  const holdTimer = useRef<number | null>(null);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    for (const tt of Array.from(v.textTracks)) {
      tt.mode = tt.language === captionLang ? "showing" : "hidden";
    }
  }, [captionLang, tracks]);

  // Lift captions above the control bar. Native cues sit at the bottom edge by
  // default, so we override each cue's line as it becomes active.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const applyLines = () => {
      for (const tt of Array.from(v.textTracks)) {
        if (tt.mode !== "showing" || !tt.cues) continue;
        for (const cue of Array.from(tt.cues)) {
          const vtt = cue as VTTCue;
          vtt.snapToLines = false;
          vtt.line = Math.max(0, 100 - subtitleOffset);
        }
      }
    };
    applyLines();
    const tracksList = Array.from(v.textTracks);
    for (const tt of tracksList) tt.addEventListener("cuechange", applyLines);
    return () => {
      for (const tt of tracksList) tt.removeEventListener("cuechange", applyLines);
    };
  }, [captionLang, subtitleOffset, tracks]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = rate;
  }, [rate, src]);

  // Apply the persisted volume to the element on load and source change.
  useEffect(() => {
    if (videoRef.current) videoRef.current.volume = volume;
  }, [src]);

  // Start playback when the source changes (opening a video, advancing a queue).
  useEffect(() => {
    videoRef.current?.play().catch(() => undefined);
  }, [src]);

  const cycleCaptions = useCallback(() => {
    if (tracks.length === 0) return;
    const order = [null, ...tracks.map((t) => t.lang)];
    const idx = order.indexOf(captionLang);
    setCaptionLang(order[(idx + 1) % order.length]);
  }, [tracks, captionLang]);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play();
    else v.pause();
  }, []);

  const toggleTheater = useCallback(() => {
    onModeChange(mode === "theater" ? "standard" : "theater");
  }, [mode, onModeChange]);

  const toggleWindowed = useCallback(() => {
    onModeChange(mode === "windowed" ? "standard" : "windowed");
  }, [mode, onModeChange]);

  const stepRate = useCallback((dir: 1 | -1) => {
    setRate((r) => {
      const idx = SPEED_STEPS.indexOf(r);
      const base = idx === -1 ? SPEED_STEPS.indexOf(1) : idx;
      const next = Math.min(SPEED_STEPS.length - 1, Math.max(0, base + dir));
      return SPEED_STEPS[next];
    });
  }, []);

  const clearHideControlsTimer = useCallback(() => {
    if (hideControlsTimer.current !== null) {
      clearTimeout(hideControlsTimer.current);
      hideControlsTimer.current = null;
    }
  }, []);

  const scheduleHideControls = useCallback(() => {
    clearHideControlsTimer();
    if (!playing || showSpeed || controlsInteracting.current) return;
    hideControlsTimer.current = window.setTimeout(() => {
      setControlsVisible(false);
      hideControlsTimer.current = null;
    }, CONTROLS_HIDE_DELAY_MS);
  }, [playing, showSpeed, clearHideControlsTimer]);

  const revealControls = useCallback(() => {
    setControlsVisible(true);
    scheduleHideControls();
  }, [scheduleHideControls]);

  const onPlayerMouseMove = useCallback(() => {
    if (isMini) return;
    revealControls();
  }, [isMini, revealControls]);

  const onPlayerMouseLeave = useCallback(() => {
    if (isMini || !playing || showSpeed || controlsInteracting.current) return;
    clearHideControlsTimer();
    setControlsVisible(false);
  }, [isMini, playing, showSpeed, clearHideControlsTimer]);

  const onControlsInteractionStart = useCallback(() => {
    controlsInteracting.current = true;
    clearHideControlsTimer();
    setControlsVisible(true);
  }, [clearHideControlsTimer]);

  const onControlsInteractionEnd = useCallback(() => {
    controlsInteracting.current = false;
    scheduleHideControls();
  }, [scheduleHideControls]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      const isPlayerKey =
        e.key === " " ||
        e.key === "k" ||
        e.key === "t" ||
        e.key === "f" ||
        e.key === "ArrowRight" ||
        e.key === "ArrowLeft" ||
        e.key === ">" ||
        e.key === "." ||
        e.key === "<" ||
        e.key === "," ||
        (e.key === "Escape" && mode === "windowed");
      if (isPlayerKey && !isMini) revealControls();
      if (e.key === " " || e.key === "k") {
        e.preventDefault();
        togglePlay();
      } else if (e.key === "t") {
        toggleTheater();
      } else if (e.key === "f") {
        toggleWindowed();
      } else if (e.key === "Escape" && mode === "windowed") {
        onModeChange("standard");
      } else if (e.key === "ArrowRight" && videoRef.current) {
        videoRef.current.currentTime += 5;
      } else if (e.key === "ArrowLeft" && videoRef.current) {
        videoRef.current.currentTime -= 5;
      } else if (e.key === ">" || e.key === ".") {
        stepRate(1);
      } else if (e.key === "<" || e.key === ",") {
        stepRate(-1);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    togglePlay,
    toggleTheater,
    toggleWindowed,
    mode,
    onModeChange,
    stepRate,
    isMini,
    revealControls,
  ]);

  const onSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = Number(e.target.value);
  };

  const onVolume = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = Number(e.target.value);
    setVolume(value);
    setMuted(value === 0);
    if (videoRef.current) {
      videoRef.current.volume = value;
      videoRef.current.muted = value === 0;
    }
    onVolumeChange?.(value);
  };

  const toggleMute = () => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = !v.muted;
    setMuted(v.muted);
  };

  const requestPiP = useCallback(async () => {
    const v = videoRef.current;
    if (!v) return;
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else if (v.requestPictureInPicture) {
        await v.requestPictureInPicture();
      }
    } catch {
      // PiP can be blocked by the browser; ignore.
    }
  }, []);

  // On mobile, hand off to Picture-in-Picture when the user backgrounds the
  // app/tab so audio and video keep playing. Restore inline view on return.
  useEffect(() => {
    if (!isMobile) return;
    const onVisibility = () => {
      const v = videoRef.current;
      if (!v) return;
      if (
        document.hidden &&
        !v.paused &&
        document.pictureInPictureEnabled &&
        !document.pictureInPictureElement
      ) {
        v.requestPictureInPicture().catch(() => undefined);
      } else if (!document.hidden && document.pictureInPictureElement) {
        document.exitPictureInPicture().catch(() => undefined);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [isMobile]);

  // Press-and-hold the video to temporarily play at 2x, restoring on release.
  // A short delay avoids triggering on a normal click (which toggles play).
  const startHold = useCallback(() => {
    if (holdTimer.current !== null || heldRate.current !== null) return;
    holdTimer.current = window.setTimeout(() => {
      heldRate.current = rate;
      setRate(2);
      holdTimer.current = null;
    }, 250);
  }, [rate]);

  const endHold = useCallback(() => {
    if (holdTimer.current !== null) {
      clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
    if (heldRate.current === null) return;
    setRate(heldRate.current);
    heldRate.current = null;
  }, []);

  useEffect(() => {
    if (isMini) return;
    if (!playing) {
      clearHideControlsTimer();
      setControlsVisible(true);
    } else {
      scheduleHideControls();
    }
  }, [isMini, playing, clearHideControlsTimer, scheduleHideControls]);

  useEffect(() => {
    if (isMini) return;
    if (showSpeed) {
      clearHideControlsTimer();
      setControlsVisible(true);
    } else if (playing) {
      scheduleHideControls();
    }
  }, [isMini, showSpeed, playing, clearHideControlsTimer, scheduleHideControls]);

  useEffect(() => () => clearHideControlsTimer(), [clearHideControlsTimer]);

  const progressPct = duration > 0 ? (current / duration) * 100 : 0;

  const wrapperClass = isMini
    ? "relative w-full bg-black"
    : mode === "windowed"
      ? "fixed inset-0 z-50 flex items-center justify-center bg-black"
      : "relative w-full bg-black";

  const innerClass =
    !isMini && mode === "windowed" ? "relative h-full w-full" : "relative";

  const videoClass = isMini
    ? "aspect-video w-full bg-black object-contain"
    : mode === "windowed"
      ? "h-full w-full object-contain"
      : isMobile
        ? "max-h-[70vh] w-full bg-black object-contain"
        : "mx-auto max-h-[85vh] w-full bg-black object-contain";
  const subtitleClass = `sub-${subtitleSize}`;

  return (
    <div className={wrapperClass}>
      <div
        className={`${innerClass}${
          !isMini && playing && !controlsVisible ? " cursor-none" : ""
        }`}
        onMouseMove={onPlayerMouseMove}
        onMouseLeave={onPlayerMouseLeave}
        onTouchStart={isMini ? undefined : revealControls}
      >
        <video
          ref={videoRef}
          src={src}
          onClick={togglePlay}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onTimeUpdate={(e) => {
            const t = e.currentTarget.currentTime;
            setCurrent(t);
            onProgress?.(t);
          }}
          onLoadedMetadata={(e) => {
            setDuration(e.currentTarget.duration);
            if (
              initialPosition > 5 &&
              initialPosition < e.currentTarget.duration
            ) {
              e.currentTarget.currentTime = initialPosition;
            }
          }}
          onEnded={onEnded}
          onMouseDown={isMini ? undefined : startHold}
          onMouseUp={isMini ? undefined : endHold}
          onMouseLeave={isMini ? undefined : endHold}
          onTouchStart={isMini ? undefined : startHold}
          onTouchEnd={isMini ? undefined : endHold}
          className={`${videoClass} ${subtitleClass}`}
        >
          {tracks.map((t) => (
            <track
              key={t.lang}
              kind="subtitles"
              src={t.src}
              srcLang={t.lang}
              label={t.lang}
            />
          ))}
        </video>

        {isMini ? (
          <div className="absolute inset-x-0 bottom-0 flex items-center gap-2 bg-gradient-to-t from-black/90 to-transparent px-3 pb-2 pt-6 text-gray-100">
            <button
              onClick={togglePlay}
              className="text-lg leading-none hover:text-accent"
            >
              {playing ? "❚❚" : "►"}
            </button>
            <span className="min-w-0 flex-1 truncate text-xs text-gray-200">
              {title}
            </span>
            <button
              onClick={onExpand}
              className="shrink-0 text-sm hover:text-accent"
              title="Expand"
            >
              ⤢
            </button>
            <button
              onClick={onClose}
              className="shrink-0 text-sm hover:text-accent"
              title="Close"
            >
              ✕
            </button>
          </div>
        ) : (
          <div
            className={`absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/95 via-black/70 to-transparent px-4 pb-3 pt-10 transition-opacity duration-300 ${
              controlsVisible
                ? "pointer-events-auto opacity-100"
                : "pointer-events-none opacity-0"
            }`}
          >
            <input
              type="range"
              min={0}
              max={duration || 0}
              step={0.1}
              value={current}
              onChange={onSeek}
              onPointerDown={onControlsInteractionStart}
              onPointerUp={onControlsInteractionEnd}
              onPointerCancel={onControlsInteractionEnd}
              className="accent-scrubber w-full"
              style={{
                background: `linear-gradient(to right, #22d3ee ${progressPct}%, #2a313f ${progressPct}%)`,
              }}
            />
            <div className="mt-2 flex items-center gap-3 text-gray-100">
              <button
                onClick={togglePlay}
                className="text-xl leading-none hover:text-accent"
              >
                {playing ? "❚❚" : "►"}
              </button>

              <div className="flex items-center gap-2">
                <button onClick={toggleMute} className="hover:text-accent">
                  {muted || volume === 0 ? "🔇" : "🔊"}
                </button>
                {!isMobile && (
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={muted ? 0 : volume}
                    onChange={onVolume}
                    onPointerDown={onControlsInteractionStart}
                    onPointerUp={onControlsInteractionEnd}
                    onPointerCancel={onControlsInteractionEnd}
                    className="accent-scrubber w-20"
                  />
                )}
              </div>

              <span className="text-xs tabular-nums text-gray-300">
                {formatDuration(current)} / {formatDuration(duration)}
              </span>

              <div className="ml-auto flex items-center gap-2">
                <div className="relative">
                  <button
                    onClick={() => setShowSpeed((s) => !s)}
                    className={`rounded px-2 py-1 text-xs font-medium tabular-nums ${
                      rate !== 1
                        ? "bg-accent text-ink-950"
                        : "bg-ink-700 text-gray-200 hover:text-accent"
                    }`}
                    title="Playback speed"
                  >
                    {rate}x
                  </button>
                  {showSpeed && (
                    <div className="absolute bottom-9 right-0 z-10 w-40 rounded-lg bg-ink-800 p-3 ring-1 ring-ink-600">
                      <div className="mb-2 grid grid-cols-3 gap-1">
                        {SPEED_STEPS.map((s) => (
                          <button
                            key={s}
                            onClick={() => setRate(s)}
                            className={`rounded px-1.5 py-1 text-[11px] font-medium tabular-nums ${
                              rate === s
                                ? "bg-accent text-ink-950"
                                : "bg-ink-700 text-gray-200 hover:text-accent"
                            }`}
                          >
                            {s}x
                          </button>
                        ))}
                      </div>
                      <input
                        type="range"
                        min={0.25}
                        max={3}
                        step={0.05}
                        value={rate}
                        onChange={(e) => setRate(Number(e.target.value))}
                        className="accent-scrubber w-full"
                      />
                    </div>
                  )}
                </div>
                {tracks.length > 0 && (
                  <button
                    onClick={cycleCaptions}
                    className={`rounded px-2 py-1 text-xs font-medium ${
                      captionLang
                        ? "bg-accent text-ink-950"
                        : "bg-ink-700 text-gray-200 hover:text-accent"
                    }`}
                    title="Subtitles"
                  >
                    {captionLang ? `CC ${captionLang}` : "CC"}
                  </button>
                )}
                {!isMobile && (
                  <>
                    <button
                      onClick={requestPiP}
                      className="rounded bg-ink-700 px-2 py-1 text-xs font-medium text-gray-200 hover:text-accent"
                      title="Picture in picture"
                    >
                      PiP
                    </button>
                    <button
                      onClick={toggleTheater}
                      className={`rounded px-2 py-1 text-xs font-medium ${
                        mode === "theater"
                          ? "bg-accent text-ink-950"
                          : "bg-ink-700 text-gray-200 hover:text-accent"
                      }`}
                      title="Theater mode (t)"
                    >
                      Theater
                    </button>
                    <button
                      onClick={toggleWindowed}
                      className={`rounded px-2 py-1 text-xs font-medium ${
                        mode === "windowed"
                          ? "bg-accent text-ink-950"
                          : "bg-ink-700 text-gray-200 hover:text-accent"
                      }`}
                      title="Windowed fullscreen (f)"
                    >
                      {mode === "windowed" ? "Exit" : "Fullscreen"}
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
