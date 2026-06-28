import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { formatDuration, formatTimestamp, type Chapter } from "../utils";
import type { SubtitleSize } from "../hooks/useSettings";
import { useIsMobile } from "../hooks/useIsMobile";
import type { SponsorSegment } from "../hooks/useSponsorBlock";

export type ViewMode = "standard" | "theater" | "windowed";

export interface SubtitleSource {
  lang: string;
  src: string;
}

const SPEED_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3];
const CONTROLS_HIDE_DELAY_MS = 2500;
const HOLD_DELAY_MS = 250;

function snapRateToStep(r: number): number {
  if (SPEED_STEPS.includes(r)) return r;
  return SPEED_STEPS.reduce((best, s) =>
    Math.abs(s - r) < Math.abs(best - r) ? s : best
  );
}

function activeChapterAt(chapters: Chapter[], time: number): Chapter | null {
  if (chapters.length === 0) return null;
  let active = chapters[0];
  for (const ch of chapters) {
    if (ch.startSec <= time) active = ch;
    else break;
  }
  return active;
}

function isChapterActive(
  chapters: Chapter[],
  chapterIndex: number,
  time: number
): boolean {
  const ch = chapters[chapterIndex];
  const next = chapters[chapterIndex + 1];
  return time >= ch.startSec && (!next || time < next.startSec);
}

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
  onSubtitleOffsetChange?: (offset: number) => void;
  defaultRate?: number;
  volume?: number;
  onVolumeChange?: (volume: number) => void;
  initialPosition?: number;
  onProgress?: (sec: number) => void;
  chapters?: Chapter[];
  sponsorSegments?: SponsorSegment[];
  sponsorShowNotice?: boolean;
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
  onSubtitleOffsetChange,
  defaultRate = 1,
  volume: volumeProp,
  onVolumeChange,
  initialPosition = 0,
  onProgress,
  chapters = [],
  sponsorSegments = [],
  sponsorShowNotice = true,
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
  const [rate, setRate] = useState(() => snapRateToStep(defaultRate));
  const [showSpeed, setShowSpeed] = useState(false);
  const [videoAspect, setVideoAspect] = useState<number | null>(null);
  const heldRate = useRef<number | null>(null);
  const holdTimer = useRef<number | null>(null);
  const holdActive = useRef(false);
  const wasPlayingBeforeHold = useRef(false);
  const suppressClick = useRef(false);
  const pointerDownOnVideo = useRef(false);

  // SponsorBlock skip notice
  const [skipNotice, setSkipNotice] = useState<string | null>(null);
  const skipNoticeTimer = useRef<number | null>(null);

  // Subtitle drag
  const subtitleDragRef = useRef<{ startY: number; startOffset: number } | null>(null);

  const applyCueLines = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    const activeCues: VTTCue[] = [];
    for (const tt of Array.from(v.textTracks)) {
      if (tt.mode !== "showing") continue;
      for (const cue of Array.from(tt.activeCues ?? [])) {
        activeCues.push(cue as VTTCue);
      }
    }
    // Stack simultaneous cues upward so they don't sit on the same line.
    const lineStep = 7;
    const baseLine = Math.max(10, 100 - subtitleOffset);
    activeCues.forEach((vtt, index) => {
      try {
        vtt.snapToLines = false;
        vtt.line = baseLine - index * lineStep;
        vtt.lineAlign = "end";
        vtt.position = 50;
        vtt.positionAlign = "center";
        vtt.align = "center";
        vtt.size = 100;
      } catch {
        // Some browsers reject edits on inactive or read-only cues.
      }
    });
  }, [subtitleOffset]);

  const setCaptionMode = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    const selected = captionLang?.toLowerCase() ?? null;
    Array.from(v.textTracks).forEach((tt, i) => {
      if (!selected) {
        tt.mode = "hidden";
        return;
      }
      const metaLang = (tracks[i]?.lang ?? "").toLowerCase();
      const trackLang = (tt.language || tt.label || tracks[i]?.lang || "").toLowerCase();
      const matches =
        metaLang === selected ||
        metaLang.split("-")[0] === selected.split("-")[0] ||
        trackLang === selected ||
        trackLang.split("-")[0] === selected.split("-")[0];
      tt.mode = matches ? "showing" : "hidden";
    });
  }, [captionLang, tracks]);

  useLayoutEffect(() => {
    setCaptionMode();
  }, [setCaptionMode, tracks, src]);

  useEffect(() => {
    if (playing) setCaptionMode();
  }, [playing, setCaptionMode]);

  // Lift captions above the control bar. Native cues sit at the bottom edge by
  // default, so we override each cue's line as it becomes active.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const applyLines = () => applyCueLines();
    const onTrackLoad = () => {
      setCaptionMode();
      applyLines();
    };
    applyLines();
    setCaptionMode();
    v.addEventListener("loadedmetadata", onTrackLoad);
    const trackEls = v.querySelectorAll("track");
    for (const el of trackEls) el.addEventListener("load", onTrackLoad);
    const tracksList = Array.from(v.textTracks);
    for (const tt of tracksList) tt.addEventListener("cuechange", applyLines);
    return () => {
      v.removeEventListener("loadedmetadata", onTrackLoad);
      for (const el of trackEls) el.removeEventListener("load", onTrackLoad);
      for (const tt of tracksList)
        tt.removeEventListener("cuechange", applyLines);
    };
  }, [captionLang, subtitleOffset, tracks, src, setCaptionMode, applyCueLines]);

  // Listen for programmatic seek requests (e.g., clicking a chapter in Watch.tsx)
  useEffect(() => {
    const handler = (e: Event) => {
      const { sec } = (e as CustomEvent<{ sec: number }>).detail;
      if (videoRef.current) videoRef.current.currentTime = sec;
    };
    window.addEventListener("horde:seek", handler);
    return () => window.removeEventListener("horde:seek", handler);
  }, []);

  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = rate;
  }, [rate, src]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.volume = volume;
  }, [src]);

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
    if (suppressClick.current) return;
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
        e.key === "n" ||
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
      } else if (e.key === "n" && chapters.length > 0 && videoRef.current) {
        e.preventDefault();
        const t = videoRef.current.currentTime;
        const next = chapters.find((c) => c.startSec > t + 1);
        if (next) videoRef.current.currentTime = next.startSec;
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
    chapters,
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

  const enterPiP = useCallback(async () => {
    const v = videoRef.current;
    if (!v?.requestPictureInPicture) return;
    await v.requestPictureInPicture();
    applyCueLines();
  }, [applyCueLines]);

  const requestPiP = useCallback(async () => {
    const v = videoRef.current;
    if (!v) return;
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else {
        await enterPiP();
      }
    } catch {
      // PiP can be blocked by the browser; ignore.
    }
  }, [enterPiP]);

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
        enterPiP().catch(() => undefined);
      } else if (!document.hidden && document.pictureInPictureElement) {
        document.exitPictureInPicture().catch(() => undefined);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [isMobile, enterPiP]);

  // Re-apply cue positioning when PiP starts (some browsers reset cues).
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onEnterPiP = () => applyCueLines();
    v.addEventListener("enterpictureinpicture", onEnterPiP);
    return () => v.removeEventListener("enterpictureinpicture", onEnterPiP);
  }, [applyCueLines]);

  // Block iOS native fullscreen hijack; keep playback inline unless windowed.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onBeginFullscreen = () => {
      if (mode !== "windowed") {
        const el = v as HTMLVideoElement & {
          webkitExitFullscreen?: () => void;
        };
        el.webkitExitFullscreen?.();
      }
    };
    v.addEventListener("webkitbeginfullscreen", onBeginFullscreen);
    return () => v.removeEventListener("webkitbeginfullscreen", onBeginFullscreen);
  }, [mode]);

  const activateHold = useCallback(() => {
    const v = videoRef.current;
    if (!v || heldRate.current !== null) return;
    holdActive.current = true;
    wasPlayingBeforeHold.current = !v.paused;
    heldRate.current = rate;
    setRate(2);
    if (v.paused) v.play().catch(() => undefined);
  }, [rate]);

  const endHold = useCallback(() => {
    if (holdTimer.current !== null) {
      clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
    if (!holdActive.current && heldRate.current === null) return;

    const v = videoRef.current;
    const hadHold = holdActive.current;
    const shouldResume = wasPlayingBeforeHold.current;

    if (heldRate.current !== null) {
      setRate(heldRate.current);
      heldRate.current = null;
    }
    holdActive.current = false;
    wasPlayingBeforeHold.current = false;

    if (hadHold) {
      suppressClick.current = true;
      window.setTimeout(() => {
        suppressClick.current = false;
      }, 300);
      if (shouldResume && v?.paused) {
        v.play().catch(() => undefined);
      }
    }
  }, []);

  const onVideoPointerDown = useCallback(
    (e: React.PointerEvent<HTMLVideoElement>) => {
      if (isMini) return;
      pointerDownOnVideo.current = true;
      if (e.pointerType === "touch") {
        e.currentTarget.setPointerCapture(e.pointerId);
      }
      if (holdTimer.current !== null || heldRate.current !== null) return;
      holdTimer.current = window.setTimeout(() => {
        holdTimer.current = null;
        activateHold();
      }, HOLD_DELAY_MS);
    },
    [isMini, activateHold]
  );

  const onVideoPointerUp = useCallback(
    (e: React.PointerEvent<HTMLVideoElement>) => {
      if (isMini) return;
      const wasHold = holdActive.current;
      const wasShortTap =
        pointerDownOnVideo.current && !wasHold && holdTimer.current !== null;

      endHold();

      if (wasShortTap && isMobile) {
        e.preventDefault();
        suppressClick.current = true;
        window.setTimeout(() => {
          suppressClick.current = false;
        }, 300);
        togglePlay();
      }

      pointerDownOnVideo.current = false;
      if (e.pointerType === "touch") {
        try {
          e.currentTarget.releasePointerCapture(e.pointerId);
        } catch {
          // ignore
        }
      }
    },
    [isMini, endHold, isMobile, togglePlay]
  );

  const onVideoPointerCancel = useCallback(() => {
    if (isMini) return;
    endHold();
    pointerDownOnVideo.current = false;
  }, [isMini, endHold]);

  const onVideoClick = useCallback(
    (e: React.MouseEvent<HTMLVideoElement>) => {
      if (suppressClick.current || holdActive.current) {
        e.preventDefault();
        return;
      }
      if (isMobile) {
        e.preventDefault();
        return;
      }
      togglePlay();
    },
    [isMobile, togglePlay]
  );

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
    ? `relative w-full bg-black${isMobile ? " max-h-32" : ""}`
    : mode === "windowed"
      ? "relative flex h-full w-full items-center justify-center bg-black"
      : "relative w-full bg-black";

  const innerClass =
    !isMini && mode === "windowed" ? "relative h-full w-full" : "relative";

  const miniStyle =
    isMini && videoAspect
      ? { aspectRatio: `${videoAspect}` as const }
      : isMini
        ? { aspectRatio: "16 / 9" as const }
        : undefined;

  const videoClass = isMini
    ? "h-full w-full bg-black object-contain"
    : mode === "windowed"
      ? "h-full w-full object-contain"
      : isMobile
        ? "max-h-[70vh] w-full bg-black object-contain"
        : "mx-auto max-h-[85vh] w-full bg-black object-contain";
  const subtitleClass = `sub-${subtitleSize}`;

  return (
    <div className={wrapperClass} style={miniStyle}>
      <div
        className={`${innerClass}${
          !isMini && playing && !controlsVisible ? " cursor-none" : ""
        }`}
        style={isMini ? undefined : { touchAction: "manipulation" }}
        onMouseMove={onPlayerMouseMove}
        onMouseLeave={onPlayerMouseLeave}
        onTouchStart={isMini ? undefined : revealControls}
      >
        <video
          ref={videoRef}
          src={src}
          playsInline
          controls={false}
          onClick={onVideoClick}
          onPlay={() => {
            setPlaying(true);
            setCaptionMode();
          }}
          onPause={() => setPlaying(false)}
          onTimeUpdate={(e) => {
            const t = e.currentTarget.currentTime;
            setCurrent(t);
            onProgress?.(t);
            // SponsorBlock: auto-skip segments
            if (sponsorSegments.length > 0) {
              for (const seg of sponsorSegments) {
                if (t >= seg.startSec && t < seg.endSec - 0.3) {
                  e.currentTarget.currentTime = seg.endSec;
                  if (sponsorShowNotice) {
                    const label =
                      seg.category === "sponsor"
                        ? "Sponsor"
                        : seg.category === "selfpromo"
                          ? "Self-promo"
                          : seg.category === "intro"
                            ? "Intro"
                            : seg.category === "outro"
                              ? "Outro"
                              : "Segment";
                    setSkipNotice(`Skipped: ${label}`);
                    if (skipNoticeTimer.current !== null)
                      clearTimeout(skipNoticeTimer.current);
                    skipNoticeTimer.current = window.setTimeout(() => {
                      setSkipNotice(null);
                      skipNoticeTimer.current = null;
                    }, 2000);
                  }
                  break;
                }
              }
            }
          }}
          onLoadedMetadata={(e) => {
            const el = e.currentTarget;
            setDuration(el.duration);
            if (el.videoWidth > 0 && el.videoHeight > 0) {
              setVideoAspect(el.videoWidth / el.videoHeight);
            }
            if (
              initialPosition > 5 &&
              initialPosition < el.duration
            ) {
              el.currentTime = initialPosition;
            }
          }}
          onEnded={onEnded}
          onPointerDown={isMini ? undefined : onVideoPointerDown}
          onPointerUp={isMini ? undefined : onVideoPointerUp}
          onPointerCancel={isMini ? undefined : onVideoPointerCancel}
          onMouseLeave={isMini ? undefined : endHold}
          className={`${videoClass} ${subtitleClass}`}
        >
          {tracks.map((t) => (
            <track
              key={`${src}-${t.lang}`}
              kind="subtitles"
              src={t.src}
              srcLang={t.lang}
              label={t.lang}
            />
          ))}
        </video>

        {isMini ? (
          <div className="absolute inset-x-0 bottom-0 flex items-center gap-1 bg-gradient-to-t from-black/90 to-transparent px-2 pb-1 pt-8 text-gray-100">
            <button
              onClick={togglePlay}
              className="flex min-h-[44px] min-w-[44px] items-center justify-center text-xl leading-none hover:text-accent"
              aria-label={playing ? "Pause" : "Play"}
            >
              {playing ? "❚❚" : "►"}
            </button>
            <span className="min-w-0 flex-1 truncate text-xs text-gray-200">
              {title}
            </span>
            <button
              onClick={onExpand}
              className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center text-base hover:text-accent"
              title="Expand"
              aria-label="Expand"
            >
              ⤢
            </button>
            <button
              onClick={onClose}
              className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center text-base hover:text-accent"
              title="Close"
              aria-label="Close"
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
            <div className="relative">
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
                background: `linear-gradient(to right, rgb(var(--accent)) ${progressPct}%, rgb(var(--ink-600)) ${progressPct}%)`,
              }}
            />
            {/* Chapter markers */}
            {chapters.length > 0 && duration > 0 && (
              <div className="absolute inset-x-0 top-0 h-full">
                {chapters.slice(1).map((ch, i) => {
                  const chapterIndex = i + 1;
                  const active = isChapterActive(chapters, chapterIndex, current);
                  return (
                    <button
                      key={ch.startSec}
                      type="button"
                      className="group absolute top-1/2 z-10 h-4 w-3 -translate-x-1/2 -translate-y-1/2"
                      style={{ left: `${(ch.startSec / duration) * 100}%` }}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (videoRef.current) {
                          videoRef.current.currentTime = ch.startSec;
                        }
                      }}
                      title={`${formatTimestamp(ch.startSec)} — ${ch.title}`}
                    >
                      <span
                        className={`absolute left-1/2 top-1/2 block h-3 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full transition-colors ${
                          active
                            ? "bg-accent"
                            : "bg-white/50 group-hover:bg-accent"
                        }`}
                      />
                      <span className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-2 hidden max-w-[200px] -translate-x-1/2 truncate rounded bg-black/90 px-2 py-1 text-xs text-gray-100 group-hover:block">
                        <span className="font-mono text-accent">
                          {formatTimestamp(ch.startSec)}
                        </span>{" "}
                        {ch.title}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
            </div>
            {/* SponsorBlock skip notice */}
            {skipNotice && (
              <div className="pointer-events-none absolute right-4 top-4 rounded-lg bg-black/80 px-3 py-1.5 text-xs text-accent transition-opacity">
                {skipNotice}
              </div>
            )}
            {/* Subtitle drag handle — only shown when CC is active */}
            {captionLang && onSubtitleOffsetChange && (
              <div
                className="absolute inset-x-0 top-0 flex cursor-ns-resize justify-center opacity-0 hover:opacity-100"
                style={{ height: "24px", marginTop: "-24px" }}
                title="Drag to reposition subtitles"
                onPointerDown={(e) => {
                  e.stopPropagation();
                  e.currentTarget.setPointerCapture(e.pointerId);
                  subtitleDragRef.current = {
                    startY: e.clientY,
                    startOffset: subtitleOffset,
                  };
                }}
                onPointerMove={(e) => {
                  if (!subtitleDragRef.current) return;
                  const dy = subtitleDragRef.current.startY - e.clientY;
                  const newOffset = Math.max(
                    0,
                    Math.min(40, subtitleDragRef.current.startOffset + Math.round(dy / 4))
                  );
                  onSubtitleOffsetChange(newOffset);
                }}
                onPointerUp={() => {
                  subtitleDragRef.current = null;
                }}
                onPointerCancel={() => {
                  subtitleDragRef.current = null;
                }}
              >
                <div className="h-1 w-12 rounded-full bg-white/40" />
              </div>
            )}
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
                {chapters.length > 0 && (() => {
                  const ch = activeChapterAt(chapters, current);
                  return ch ? (
                    <span className="mr-2 max-w-[140px] truncate text-gray-400">
                      {ch.title} ·{" "}
                    </span>
                  ) : null;
                })()}
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
                    CC
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
