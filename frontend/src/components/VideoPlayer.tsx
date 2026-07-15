import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { absoluteUrl, api, spritesImageUrl, streamUrl } from "../api";
import LoadingIndicator from "./LoadingIndicator";
import { useAirPlay } from "../hooks/useAirPlay";
import { useChromecast } from "../hooks/useChromecast";
import type { SubtitleSize } from "../hooks/useSettings";
import { useIsMobile } from "../hooks/useIsMobile";
import type { SponsorSegment } from "../hooks/useSponsorBlock";
import type { SpriteMeta } from "../types";
import { formatDuration, formatTimestamp, type Chapter } from "../utils";

export type ViewMode = "standard" | "theater" | "windowed";

export interface SubtitleSource {
  lang: string;
  src: string;
}

const SPEED_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3];
const CONTROLS_HIDE_DELAY_MS = 2500;
const HOLD_DELAY_MS = 250;
const MIN_MINI_WIDTH = 160;
const MAX_MINI_WIDTH = 960;

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
  videoId?: number;
  mimeType?: string;
  poster?: string | null;
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
  subtitlesPending?: boolean;
  onSubtitlesRefresh?: () => void;
  miniWidth?: number | null;
  onMiniResize?: (width: number) => void;
  onMiniMove?: (left: number, top: number) => void;
  onMiniMoveEnd?: () => void;
  upNext?: {
    title: string;
    channel: string | null;
    poster: string | null;
    seconds: number;
  } | null;
  onCancelUpNext?: () => void;
  onPlayUpNext?: () => void;
  autoplayRelated?: boolean;
  onAutoplayRelatedChange?: (enabled: boolean) => void;
}

export default function VideoPlayer({
  src,
  videoId,
  mimeType = "video/mp4",
  poster = null,
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
  subtitlesPending = false,
  onSubtitlesRefresh,
  miniWidth = null,
  onMiniResize,
  onMiniMove,
  onMiniMoveEnd,
  upNext = null,
  onCancelUpNext,
  onPlayUpNext,
  autoplayRelated = true,
  onAutoplayRelatedChange,
}: Props) {
  const isMini = variant === "mini";
  const isMobile = useIsMobile();
  const videoRef = useRef<HTMLVideoElement>(null);
  const chromecast = useChromecast();
  const airplay = useAirPlay(videoRef, src);
  const playerRootRef = useRef<HTMLDivElement>(null);
  const userInitiatedFullscreen = useRef(false);
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
  const [isNativeFullscreen, setIsNativeFullscreen] = useState(false);
  const [miniControlsVisible, setMiniControlsVisible] = useState(true);
  const [videoAspect, setVideoAspect] = useState<number | null>(null);
  const miniHideTimer = useRef<number | null>(null);
  const miniResizeDrag = useRef<{ startX: number; startWidth: number } | null>(
    null
  );
  const heldRate = useRef<number | null>(null);
  const holdTimer = useRef<number | null>(null);
  const holdActive = useRef(false);
  const wasPlayingBeforeHold = useRef(false);
  const suppressClick = useRef(false);
  const pointerDownOnVideo = useRef(false);

  // SponsorBlock skip notice
  const [skipNotice, setSkipNotice] = useState<string | null>(null);
  const [skippedSegment, setSkippedSegment] = useState<{
    startSec: number;
    endSec: number;
    label: string;
  } | null>(null);
  const skipNoticeTimer = useRef<number | null>(null);
  const prevTimeRef = useRef(0);
  const isSeekingRef = useRef(false);
  const pendingSeekRef = useRef(initialPosition);
  const [buffering, setBuffering] = useState(true);
  const suppressedSegmentsRef = useRef(new Set<string>());
  const [ccNotice, setCcNotice] = useState<string | null>(null);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [spriteMeta, setSpriteMeta] = useState<SpriteMeta | null>(null);
  const [scrubHover, setScrubHover] = useState<{
    time: number;
    pct: number;
  } | null>(null);
  const scrubberRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    pendingSeekRef.current = initialPosition;
    const el = videoRef.current;
    if (!el || initialPosition <= 1) return;
    // Same-src handoff (preview → library): metadata already loaded, seek now.
    if (el.readyState >= 1 && Number.isFinite(el.duration) && initialPosition < el.duration) {
      if (Math.abs(el.currentTime - initialPosition) > 1.25) {
        el.currentTime = initialPosition;
      }
      pendingSeekRef.current = 0;
      if (!chromecast.casting) {
        el.play().catch(() => undefined);
      }
    }
  }, [initialPosition, src, chromecast.casting]);

  // Subtitle drag
  const subtitleDragRef = useRef<{ startY: number; startOffset: number } | null>(null);

  const castAvailable = chromecast.available || airplay.available;
  const casting = chromecast.casting || airplay.casting;
  const castDeviceName = chromecast.casting
    ? chromecast.deviceName
    : airplay.casting
      ? "AirPlay"
      : null;

  useEffect(() => {
    suppressedSegmentsRef.current.clear();
    prevTimeRef.current = 0;
    setSkippedSegment(null);
    setSkipNotice(null);
    setCcNotice(null);
    setMediaError(null);
    setBuffering(true);
  }, [src]);

  // Lazy-load seek-preview sprites for full library playback.
  useEffect(() => {
    if (isMini || videoId == null) {
      setSpriteMeta(null);
      setScrubHover(null);
      return;
    }
    let cancelled = false;
    let pollTimer: number | null = null;
    const pollDeadline = Date.now() + 60_000;

    const applyMeta = (meta: SpriteMeta) => {
      if (!cancelled) setSpriteMeta(meta);
    };

    const load = async () => {
      try {
        const meta = await api.getSpriteMeta(videoId);
        applyMeta(meta);
        return;
      } catch {
        // missing — kick off generation
      }
      if (cancelled) return;
      try {
        const { status } = await api.ensureSprites(videoId);
        if (status === "ready") {
          const meta = await api.getSpriteMeta(videoId);
          applyMeta(meta);
          return;
        }
      } catch {
        return;
      }

      const poll = async () => {
        if (cancelled || Date.now() > pollDeadline) return;
        try {
          const meta = await api.getSpriteMeta(videoId);
          applyMeta(meta);
          return;
        } catch {
          pollTimer = window.setTimeout(poll, 2000);
        }
      };
      pollTimer = window.setTimeout(poll, 2000);
    };

    setSpriteMeta(null);
    void load();
    return () => {
      cancelled = true;
      if (pollTimer !== null) clearTimeout(pollTimer);
    };
  }, [isMini, videoId]);

  const updateScrubHover = useCallback(
    (clientX: number) => {
      const el = scrubberRef.current;
      if (!el || duration <= 0) return;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0) return;
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      setScrubHover({ time: ratio * duration, pct: ratio * 100 });
    },
    [duration]
  );

  const onScrubPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      updateScrubHover(e.clientX);
    },
    [updateScrubHover]
  );

  const onScrubPointerLeave = useCallback(() => {
    setScrubHover(null);
  }, []);

  const undoSkip = useCallback(() => {
    const seg = skippedSegment;
    const v = videoRef.current;
    if (!seg || !v) return;
    suppressedSegmentsRef.current.add(`${seg.startSec}-${seg.endSec}`);
    v.currentTime = seg.startSec;
    setSkipNotice(null);
    setSkippedSegment(null);
    if (skipNoticeTimer.current !== null) {
      clearTimeout(skipNoticeTimer.current);
      skipNoticeTimer.current = null;
    }
  }, [skippedSegment]);

  const segmentLabel = useCallback((category: string) => {
    if (category === "sponsor") return "Sponsor";
    if (category === "selfpromo") return "Self-promo";
    if (category === "intro") return "Intro";
    if (category === "outro") return "Outro";
    return "Segment";
  }, []);

  useEffect(() => {
    chromecast.setOnSessionEnd((position) => {
      const v = videoRef.current;
      if (!v) return;
      if (position > 0) {
        v.currentTime = position;
        setCurrent(position);
        onProgress?.(position);
      }
      v.play().catch(() => undefined);
    });
  }, [chromecast.setOnSessionEnd, onProgress]);

  useEffect(() => {
    if (!chromecast.casting) return;
    setCurrent(chromecast.remoteCurrentTime);
    setDuration(chromecast.remoteDuration);
    setPlaying(!chromecast.remoteIsPaused);
  }, [
    chromecast.casting,
    chromecast.remoteCurrentTime,
    chromecast.remoteDuration,
    chromecast.remoteIsPaused,
  ]);

  const startChromecast = useCallback(async () => {
    const v = videoRef.current;
    if (!v || videoId == null) return;
    v.pause();
    try {
      await chromecast.castMedia({
        contentUrl: absoluteUrl(streamUrl(videoId)),
        mimeType,
        title: title ?? "Video",
        posterUrl: poster ? absoluteUrl(poster) : null,
        currentTime: v.currentTime,
        subtitles: tracks.map((t) => ({
          lang: t.lang,
          src: absoluteUrl(t.src),
        })),
        activeSubtitleLang: captionLang,
      });
    } catch {
      // User cancelled device picker or load failed.
    }
  }, [
    videoId,
    mimeType,
    title,
    poster,
    tracks,
    captionLang,
    chromecast.castMedia,
  ]);

  const onCastClick = useCallback(() => {
    if (chromecast.casting) {
      chromecast.stop();
      return;
    }
    if (chromecast.available) {
      void startChromecast();
      return;
    }
    if (airplay.available) {
      airplay.showPicker();
    }
  }, [
    chromecast.casting,
    chromecast.available,
    chromecast.stop,
    startChromecast,
    airplay.available,
    airplay.showPicker,
  ]);

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

  const seekTo = useCallback(
    (sec: number) => {
      const t = Math.max(0, sec);
      isSeekingRef.current = true;
      prevTimeRef.current = t;
      setCurrent(t);
      if (chromecast.casting) {
        chromecast.remoteSeek(t);
        return;
      }
      if (videoRef.current) videoRef.current.currentTime = t;
    },
    [chromecast.casting, chromecast.remoteSeek]
  );

  // Listen for programmatic seek requests (e.g., clicking a chapter in Watch.tsx)
  useEffect(() => {
    const handler = (e: Event) => {
      const { sec } = (e as CustomEvent<{ sec: number }>).detail;
      seekTo(sec);
    };
    window.addEventListener("horde:seek", handler);
    return () => window.removeEventListener("horde:seek", handler);
  }, [seekTo]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = rate;
  }, [rate, src]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.volume = volume;
  }, [src]);

  useEffect(() => {
    if (chromecast.casting) return;
    videoRef.current?.play().catch(() => undefined);
  }, [src, chromecast.casting]);

  const cycleCaptions = useCallback(() => {
    if (tracks.length === 0) {
      if (subtitlesPending) {
        setCcNotice("Subtitles still loading…");
        onSubtitlesRefresh?.();
        window.setTimeout(() => setCcNotice(null), 3000);
      }
      return;
    }
    const order = [null, ...tracks.map((t) => t.lang)];
    const idx = order.indexOf(captionLang);
    setCaptionLang(order[(idx + 1) % order.length]);
    setCcNotice(null);
  }, [tracks, captionLang, subtitlesPending, onSubtitlesRefresh]);

  const togglePlay = useCallback(() => {
    if (suppressClick.current) return;
    if (chromecast.casting) {
      chromecast.remotePlay();
      return;
    }
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play();
    else v.pause();
  }, [chromecast.casting, chromecast.remotePlay]);

  const modeBeforeWindowed = useRef<ViewMode>("standard");

  const toggleTheater = useCallback(() => {
    if (mode === "windowed") return;
    onModeChange(mode === "theater" ? "standard" : "theater");
  }, [mode, onModeChange]);

  const toggleWindowed = useCallback(() => {
    if (mode === "windowed") {
      onModeChange(modeBeforeWindowed.current);
    } else {
      modeBeforeWindowed.current = mode;
      onModeChange("windowed");
    }
  }, [mode, onModeChange]);

  const exitNativeFullscreen = useCallback(async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      }
      screen.orientation?.unlock?.();
    } catch {
      // Browser may reject unlock or exit.
    }
    userInitiatedFullscreen.current = false;
  }, []);

  const enterNativeFullscreen = useCallback(async () => {
    const root = playerRootRef.current;
    const video = videoRef.current;
    if (!root || !video) return;

    userInitiatedFullscreen.current = true;

    const req =
      root.requestFullscreen?.bind(root) ??
      (
        root as HTMLElement & {
          webkitRequestFullscreen?: () => Promise<void>;
        }
      ).webkitRequestFullscreen?.bind(root);
    if (req) {
      try {
        await req();
        try {
          const lock = (
            screen.orientation as ScreenOrientation & {
              lock?: (orientation: string) => Promise<void>;
            }
          ).lock;
          await lock?.("landscape");
        } catch {
          // Orientation lock may be unsupported or denied.
        }
        return;
      } catch {
        userInitiatedFullscreen.current = false;
      }
    }

    const el = video as HTMLVideoElement & {
      webkitEnterFullscreen?: () => void;
    };
    if (el.webkitEnterFullscreen) {
      el.webkitEnterFullscreen();
      return;
    }

    userInitiatedFullscreen.current = false;
  }, []);

  const toggleNativeFullscreen = useCallback(async () => {
    if (document.fullscreenElement || isNativeFullscreen) {
      await exitNativeFullscreen();
    } else {
      await enterNativeFullscreen();
    }
  }, [enterNativeFullscreen, exitNativeFullscreen, isNativeFullscreen]);

  useEffect(() => {
    const onChange = () => {
      const active = !!document.fullscreenElement;
      setIsNativeFullscreen(active);
      document.body.classList.toggle("player-fullscreen", active);
      if (!active) {
        userInitiatedFullscreen.current = false;
        try {
          screen.orientation?.unlock?.();
        } catch {
          // ignore
        }
      }
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      document.body.classList.remove("player-fullscreen");
    };
  }, []);

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

  const clearMiniHideTimer = useCallback(() => {
    if (miniHideTimer.current !== null) {
      clearTimeout(miniHideTimer.current);
      miniHideTimer.current = null;
    }
  }, []);

  const scheduleHideMiniControls = useCallback(() => {
    clearMiniHideTimer();
    if (!playing) return;
    miniHideTimer.current = window.setTimeout(() => {
      setMiniControlsVisible(false);
      miniHideTimer.current = null;
    }, CONTROLS_HIDE_DELAY_MS);
  }, [playing, clearMiniHideTimer]);

  const revealMiniControls = useCallback(() => {
    setMiniControlsVisible(true);
    scheduleHideMiniControls();
  }, [scheduleHideMiniControls]);

  const onPlayerMouseMove = useCallback(() => {
    if (isMini) {
      revealMiniControls();
      return;
    }
    revealControls();
  }, [isMini, revealControls, revealMiniControls]);

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
        e.key === "c" ||
        e.key === "C" ||
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
      } else if (e.key === "c" || e.key === "C") {
        e.preventDefault();
        cycleCaptions();
      } else if (e.key === "t") {
        toggleTheater();
      } else if (e.key === "f") {
        toggleWindowed();
      } else if (e.key === "Escape" && mode === "windowed") {
        onModeChange(modeBeforeWindowed.current);
      } else if (e.key === "ArrowRight" && videoRef.current) {
        seekTo(videoRef.current.currentTime + 5);
      } else if (e.key === "ArrowLeft" && videoRef.current) {
        seekTo(videoRef.current.currentTime - 5);
      } else if (e.key === ">" || e.key === ".") {
        stepRate(1);
      } else if (e.key === "<" || e.key === ",") {
        stepRate(-1);
      } else if (e.key === "n" && chapters.length > 0 && videoRef.current) {
        e.preventDefault();
        const t = videoRef.current.currentTime;
        const next = chapters.find((c) => c.startSec > t + 1);
        if (next) seekTo(next.startSec);
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
    cycleCaptions,
    seekTo,
  ]);

  const onSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const t = Number(e.target.value);
    seekTo(t);
    if (duration > 0) {
      setScrubHover({ time: t, pct: (t / duration) * 100 });
    }
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

  // Block iOS native fullscreen hijack unless the user tapped Fullscreen.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onBeginFullscreen = () => {
      if (mode !== "windowed" && !userInitiatedFullscreen.current) {
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
    if (!isMini) return;
    if (!playing) {
      clearMiniHideTimer();
      setMiniControlsVisible(true);
    } else {
      scheduleHideMiniControls();
    }
  }, [isMini, playing, clearMiniHideTimer, scheduleHideMiniControls]);

  useEffect(() => () => clearMiniHideTimer(), [clearMiniHideTimer]);

  const clampMiniWidth = useCallback((width: number) => {
    const max = Math.min(window.innerWidth * 0.9, MAX_MINI_WIDTH);
    return Math.min(max, Math.max(MIN_MINI_WIDTH, width));
  }, []);

  const onMiniResizePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      const startWidth =
        miniWidth ??
        playerRootRef.current?.getBoundingClientRect().width ??
        (isMobile ? 224 : 704);
      miniResizeDrag.current = { startX: e.clientX, startWidth };

      const onMove = (ev: PointerEvent) => {
        if (!miniResizeDrag.current || !onMiniResize) return;
        const { startX, startWidth: sw } = miniResizeDrag.current;
        onMiniResize(clampMiniWidth(sw + (startX - ev.clientX)));
      };
      const onEnd = () => {
        miniResizeDrag.current = null;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onEnd);
        window.removeEventListener("pointercancel", onEnd);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onEnd);
      window.addEventListener("pointercancel", onEnd);
    },
    [miniWidth, isMobile, clampMiniWidth, onMiniResize]
  );

  const miniMoveDrag = useRef<{
    startX: number;
    startY: number;
    origLeft: number;
    origTop: number;
    pointerId: number;
    moved: boolean;
  } | null>(null);

  const onMiniMovePointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      if (!onMiniMove || !isMini) return;
      if (e.button !== 0 && e.pointerType === "mouse") return;
      const hit = e.target as HTMLElement | null;
      if (
        hit?.closest(
          "button, input, select, textarea, a, [data-mini-no-drag]"
        )
      ) {
        return;
      }
      // Don't preventDefault here — that would swallow video click-to-play.
      const root = playerRootRef.current;
      if (!root) return;
      const rect = root.getBoundingClientRect();
      miniMoveDrag.current = {
        startX: e.clientX,
        startY: e.clientY,
        origLeft: rect.left,
        origTop: rect.top,
        pointerId: e.pointerId,
        moved: false,
      };
      // Window listeners keep tracking when the pointer outruns the mini.
      const onMove = (ev: PointerEvent) => {
        if (!miniMoveDrag.current || !onMiniMove) return;
        if (ev.pointerId !== miniMoveDrag.current.pointerId) return;
        const { startX, startY, origLeft, origTop } = miniMoveDrag.current;
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        if (!miniMoveDrag.current.moved && dx * dx + dy * dy < 16) return;
        if (!miniMoveDrag.current.moved) {
          miniMoveDrag.current.moved = true;
          suppressClick.current = true;
        }
        ev.preventDefault();
        onMiniMove(origLeft + dx, origTop + dy);
      };
      const onEnd = (ev: PointerEvent) => {
        if (
          miniMoveDrag.current &&
          ev.pointerId !== miniMoveDrag.current.pointerId
        ) {
          return;
        }
        const didMove = miniMoveDrag.current?.moved ?? false;
        miniMoveDrag.current = null;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onEnd);
        window.removeEventListener("pointercancel", onEnd);
        if (didMove) onMiniMoveEnd?.();
        if (didMove) {
          window.setTimeout(() => {
            suppressClick.current = false;
          }, 0);
        }
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onEnd);
      window.addEventListener("pointercancel", onEnd);
    },
    [isMini, onMiniMove, onMiniMoveEnd]
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

  const scrubPreview =
    scrubHover && duration > 0
      ? (() => {
          const { time, pct } = scrubHover;
          let tileStyle: React.CSSProperties | undefined;
          if (spriteMeta && videoId != null && spriteMeta.count > 0) {
            const idx = Math.min(
              spriteMeta.count - 1,
              Math.max(0, Math.floor(time / spriteMeta.interval_sec))
            );
            const col = idx % spriteMeta.columns;
            const row = Math.floor(idx / spriteMeta.columns);
            const rows = Math.max(
              1,
              Math.ceil(spriteMeta.count / spriteMeta.columns)
            );
            const sheetW = spriteMeta.columns * spriteMeta.tile_width;
            const sheetH = rows * spriteMeta.tile_height;
            tileStyle = {
              width: spriteMeta.tile_width,
              height: spriteMeta.tile_height,
              backgroundImage: `url(${spritesImageUrl(videoId)})`,
              backgroundRepeat: "no-repeat",
              backgroundSize: `${sheetW}px ${sheetH}px`,
              backgroundPosition: `-${col * spriteMeta.tile_width}px -${row * spriteMeta.tile_height}px`,
            };
          }
          return {
            time,
            pct: Math.min(92, Math.max(8, pct)),
            tileStyle,
          };
        })()
      : null;

  const wrapperClass = isMini
    ? `relative w-full bg-black${onMiniMove ? " cursor-grab active:cursor-grabbing" : ""}`
    : isNativeFullscreen
      ? "relative flex h-full w-full items-center justify-center bg-black"
      : mode === "windowed"
        ? "relative flex h-full w-full items-center justify-center bg-black"
        : "relative h-full w-full bg-black";

  const innerClass =
    !isMini && (mode === "windowed" || isNativeFullscreen)
      ? "relative h-full w-full"
      : "relative h-full w-full";

  const miniStyle =
    isMini && videoAspect
      ? { aspectRatio: `${videoAspect}` as const }
      : isMini
        ? { aspectRatio: "16 / 9" as const }
        : undefined;

  const videoClass = isMini
    ? "h-full w-full bg-black object-contain"
    : isNativeFullscreen || mode === "windowed"
      ? "h-full w-full object-contain"
      : isMobile
        ? "max-h-[70vh] w-full bg-black object-contain"
        : "mx-auto max-h-[85vh] w-full bg-black object-contain";
  const subtitleClass = `sub-${subtitleSize}`;

  // Ultrawide (e.g. 2:1) letterboxes inside a 16:9 dock — compact the up-next
  // card so it stays within the visible video picture.
  const compactUpNext = videoAspect != null && videoAspect >= 1.7;

  return (
    <div
      ref={playerRootRef}
      className={wrapperClass}
      style={miniStyle}
      onPointerDown={isMini && onMiniMove ? onMiniMovePointerDown : undefined}
    >
      <div
        className={`${innerClass}${
          !isMini && playing && !controlsVisible ? " cursor-none" : ""
        }`}
        style={{ touchAction: "manipulation" }}
        onMouseMove={onPlayerMouseMove}
        onMouseLeave={onPlayerMouseLeave}
        onTouchStart={isMini ? revealMiniControls : revealControls}
      >
        <video
          ref={videoRef}
          src={src}
          playsInline
          {...{ "x-webkit-airplay": "allow" }}
          controls={false}
          onClick={onVideoClick}
          onPlay={() => {
            setPlaying(true);
            setCaptionMode();
          }}
          onPause={() => setPlaying(false)}
          onTimeUpdate={(e) => {
            const t = e.currentTarget.currentTime;
            const prev = prevTimeRef.current;
            prevTimeRef.current = t;
            setCurrent(t);
            onProgress?.(t);
            // SponsorBlock: auto-skip on forward playback; seeking back into a
            // segment suppresses it for the rest of this source.
            // Skip while a programmatic/user seek is in flight so distant
            // chapter jumps aren't redirected mid-seek.
            if (sponsorSegments.length > 0 && !isSeekingRef.current) {
              const movingForward = t >= prev - 0.05;
              const seekingBack = t < prev - 0.05;
              for (const seg of sponsorSegments) {
                const key = `${seg.startSec}-${seg.endSec}`;
                if (suppressedSegmentsRef.current.has(key)) {
                  continue;
                }
                if (
                  seekingBack &&
                  t >= seg.startSec &&
                  t < seg.endSec
                ) {
                  suppressedSegmentsRef.current.add(key);
                  continue;
                }
                if (
                  movingForward &&
                  t >= seg.startSec &&
                  t < seg.endSec - 0.3
                ) {
                  e.currentTarget.currentTime = seg.endSec;
                  prevTimeRef.current = seg.endSec;
                  const label = segmentLabel(seg.category);
                  if (sponsorShowNotice) {
                    setSkippedSegment({
                      startSec: seg.startSec,
                      endSec: seg.endSec,
                      label,
                    });
                    setSkipNotice(`Skipped: ${label}`);
                    if (skipNoticeTimer.current !== null)
                      clearTimeout(skipNoticeTimer.current);
                    skipNoticeTimer.current = window.setTimeout(() => {
                      setSkipNotice(null);
                      setSkippedSegment(null);
                      skipNoticeTimer.current = null;
                    }, 4000);
                  }
                  break;
                }
              }
            }
          }}
          onSeeked={() => {
            isSeekingRef.current = false;
            setBuffering(false);
          }}
          onSeeking={() => {
            isSeekingRef.current = true;
          }}
          onWaiting={() => setBuffering(true)}
          onStalled={() => setBuffering(true)}
          onPlaying={() => setBuffering(false)}
          onCanPlay={() => setBuffering(false)}
          onLoadedMetadata={(e) => {
            const el = e.currentTarget;
            setDuration(el.duration);
            if (el.videoWidth > 0 && el.videoHeight > 0) {
              setVideoAspect(el.videoWidth / el.videoHeight);
            }
            const seekTarget = pendingSeekRef.current;
            if (seekTarget > 1 && seekTarget < el.duration) {
              el.currentTime = seekTarget;
            }
            pendingSeekRef.current = 0;
            if (!chromecast.casting) {
              el.play().catch(() => undefined);
            }
          }}
          onEnded={onEnded}
          onError={() => {
            setBuffering(false);
            setMediaError("This video could not be played. The file may be incomplete or corrupt.");
          }}
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

        {buffering && !mediaError && !chromecast.casting && (
          <div className="pointer-events-none absolute inset-0 z-[5] flex items-center justify-center bg-black/35">
            <LoadingIndicator label="Buffering" className="py-0" />
          </div>
        )}

        {mediaError && !isMini && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/80 px-4">
            <p className="max-w-sm text-center text-sm text-red-300">{mediaError}</p>
          </div>
        )}

        {chromecast.casting && !isMini && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center bg-black/80">
            <p className="text-sm text-gray-200">
              Casting to {castDeviceName ?? "TV"}
            </p>
          </div>
        )}

        {isMini ? (
          <>
            {onMiniResize && (
              <div
                data-mini-no-drag
                className="absolute left-0 top-0 z-30 h-4 w-4 cursor-nwse-resize touch-none"
                style={{ touchAction: "none" }}
                title="Drag to resize"
                aria-label="Drag to resize mini player"
                onPointerDown={onMiniResizePointerDown}
              />
            )}
            <div
              className={`absolute inset-x-0 top-0 z-10 flex items-center gap-1 bg-gradient-to-b from-black/90 to-transparent px-2 pb-2 pt-1 text-gray-100 transition-opacity duration-300 ${
                miniControlsVisible
                  ? "pointer-events-auto opacity-100"
                  : "pointer-events-none opacity-0"
              }`}
            >
              <button
                onClick={togglePlay}
                className="flex min-h-[48px] min-w-[48px] items-center justify-center text-2xl leading-none hover:text-accent"
                aria-label={playing ? "Pause" : "Play"}
              >
                {playing ? "❚❚" : "►"}
              </button>
              <span className="min-w-0 flex-1 truncate text-sm text-gray-200">
                {title}
              </span>
              <button
                onClick={onExpand}
                className="flex min-h-[48px] min-w-[48px] shrink-0 items-center justify-center text-lg hover:text-accent"
                title="Expand"
                aria-label="Expand"
              >
                ⤢
              </button>
              <button
                onClick={onClose}
                className="flex min-h-[48px] min-w-[48px] shrink-0 items-center justify-center text-lg hover:text-accent"
                title="Close"
                aria-label="Close"
              >
                ✕
              </button>
            </div>
          </>
        ) : (
          <div
            className={`absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/95 via-black/70 to-transparent px-4 pb-3 pt-10 transition-opacity duration-300 ${
              controlsVisible
                ? "pointer-events-auto opacity-100"
                : "pointer-events-none opacity-0"
            }`}
          >
            <div
              ref={scrubberRef}
              className="relative"
              onPointerMove={onScrubPointerMove}
              onPointerLeave={onScrubPointerLeave}
            >
            {scrubPreview && (
              <div
                className="pointer-events-none absolute bottom-full z-30 mb-2 -translate-x-1/2"
                style={{ left: `${scrubPreview.pct}%` }}
              >
                <div className="flex flex-col items-center gap-1">
                  {scrubPreview.tileStyle && (
                    <div
                      className="overflow-hidden rounded-lg border border-white/20 bg-black shadow-lg"
                      style={scrubPreview.tileStyle}
                    />
                  )}
                  <span className="rounded bg-black/90 px-1.5 py-0.5 font-mono text-xs text-accent">
                    {formatTimestamp(scrubPreview.time)}
                  </span>
                </div>
              </div>
            )}
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
              <div className="pointer-events-none absolute inset-x-0 top-0 h-full">
                {chapters.slice(1).map((ch, i) => {
                  const chapterIndex = i + 1;
                  const active = isChapterActive(chapters, chapterIndex, current);
                  return (
                    <button
                      key={ch.startSec}
                      type="button"
                      className="group pointer-events-auto absolute top-1/2 z-10 h-4 w-3 -translate-x-1/2 -translate-y-1/2"
                      style={{ left: `${(ch.startSec / duration) * 100}%` }}
                      onPointerDown={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        seekTo(ch.startSec);
                      }}
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
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
              <div className="absolute right-4 top-4 flex items-center gap-2 rounded-lg bg-black/80 px-3 py-1.5 text-xs text-accent">
                <span>{skipNotice}</span>
                {skippedSegment && (
                  <button
                    type="button"
                    onClick={undoSkip}
                    className="rounded bg-ink-700 px-2 py-0.5 text-gray-200 hover:bg-ink-600"
                  >
                    Go back
                  </button>
                )}
              </div>
            )}
            {ccNotice && (
              <div className="absolute left-4 top-4 rounded-lg bg-black/70 px-3 py-1.5 text-xs text-gray-300">
                {ccNotice}
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

              {!isMobile && (
                <div className="flex items-center gap-2">
                  <button onClick={toggleMute} className="hover:text-accent">
                    {muted || volume === 0 ? "🔇" : "🔊"}
                  </button>
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
                </div>
              )}

              <span className="text-xs tabular-nums text-gray-300">
                {formatDuration(current)} / {formatDuration(duration)}
                {chapters.length > 0 && (() => {
                  const ch = activeChapterAt(chapters, current);
                  return ch ? (
                    <span className="ml-2 max-w-[140px] truncate text-gray-400">
                      · {ch.title}
                    </span>
                  ) : null;
                })()}
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
                {(tracks.length > 0 || subtitlesPending) && (
                  <button
                    onClick={cycleCaptions}
                    className={`rounded px-2 py-1 text-xs font-medium ${
                      captionLang
                        ? "bg-accent text-ink-950"
                        : "bg-ink-700 text-gray-200 hover:text-accent"
                    }`}
                    title={
                      subtitlesPending && tracks.length === 0
                        ? "Subtitles loading"
                        : "Subtitles"
                    }
                  >
                    CC
                  </button>
                )}
                {castAvailable && (
                  <button
                    onClick={onCastClick}
                    className={`rounded px-2 py-1 text-xs font-medium ${
                      casting
                        ? "bg-accent text-ink-950"
                        : "bg-ink-700 text-gray-200 hover:text-accent"
                    }`}
                    title={
                      casting
                        ? `Casting to ${castDeviceName ?? "TV"}`
                        : "Cast to TV"
                    }
                  >
                    Cast
                  </button>
                )}
                {isMobile && (
                  <button
                    onClick={toggleNativeFullscreen}
                    className={`flex items-center justify-center rounded px-2 py-1 text-xs font-medium ${
                      isNativeFullscreen
                        ? "bg-accent text-ink-950"
                        : "bg-ink-700 text-gray-200 hover:text-accent"
                    }`}
                    title={
                      isNativeFullscreen ? "Exit fullscreen" : "Fullscreen"
                    }
                    aria-label={
                      isNativeFullscreen ? "Exit fullscreen" : "Fullscreen"
                    }
                  >
                    {isNativeFullscreen ? (
                      <svg
                        viewBox="0 0 24 24"
                        className="h-3.5 w-3.5"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        aria-hidden
                      >
                        <path d="M9 3H5a2 2 0 0 0-2 2v4M15 3h4a2 2 0 0 1 2 2v4M9 21H5a2 2 0 0 1-2-2v-4M15 21h4a2 2 0 0 0 2-2v-4" />
                      </svg>
                    ) : (
                      <svg
                        viewBox="0 0 24 24"
                        className="h-3.5 w-3.5"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        aria-hidden
                      >
                        <path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3" />
                      </svg>
                    )}
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
                      title="Fit window (f)"
                    >
                      {mode === "windowed" ? "Exit Fit" : "Fit Window"}
                    </button>
                    <button
                      onClick={toggleNativeFullscreen}
                      className={`flex items-center justify-center rounded px-2 py-1 text-xs font-medium ${
                        isNativeFullscreen
                          ? "bg-accent text-ink-950"
                          : "bg-ink-700 text-gray-200 hover:text-accent"
                      }`}
                      title={
                        isNativeFullscreen
                          ? "Exit fullscreen"
                          : "Fullscreen"
                      }
                      aria-label={
                        isNativeFullscreen
                          ? "Exit fullscreen"
                          : "Fullscreen"
                      }
                    >
                      {isNativeFullscreen ? (
                        <svg
                          viewBox="0 0 24 24"
                          className="h-3.5 w-3.5"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          aria-hidden
                        >
                          <path d="M9 3H5a2 2 0 0 0-2 2v4M15 3h4a2 2 0 0 1 2 2v4M9 21H5a2 2 0 0 1-2-2v-4M15 21h4a2 2 0 0 0 2-2v-4" />
                        </svg>
                      ) : (
                        <svg
                          viewBox="0 0 24 24"
                          className="h-3.5 w-3.5"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          aria-hidden
                        >
                          <path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3" />
                        </svg>
                      )}
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        )}

        {upNext && !isMini && (
          <div className="absolute inset-0 z-30 flex items-center justify-center overflow-hidden bg-black/65 p-4">
            <div
              className={`w-full max-w-sm overflow-hidden rounded-xl border border-ink-700 bg-ink-900/95 shadow-2xl ring-1 ring-ink-600 ${
                compactUpNext
                  ? "flex max-h-full flex-col sm:max-h-[min(100%,16rem)]"
                  : ""
              }`}
            >
              {upNext.poster && (
                <div
                  className={
                    compactUpNext
                      ? "max-h-[4.5rem] w-full shrink-0 overflow-hidden bg-ink-800 sm:max-h-[5.5rem]"
                      : "aspect-video w-full overflow-hidden bg-ink-800"
                  }
                >
                  <img
                    src={upNext.poster}
                    alt=""
                    className="h-full w-full object-cover opacity-90"
                  />
                </div>
              )}
              <div
                className={
                  compactUpNext
                    ? "min-h-0 flex-1 overflow-y-auto p-3"
                    : "p-4"
                }
              >
                <p className="text-xs font-semibold uppercase tracking-wide text-accent">
                  Playing next
                  {upNext.seconds > 0 ? ` in ${upNext.seconds}s` : ""}
                </p>
                <p className="mt-1 line-clamp-2 text-sm font-medium text-gray-100">
                  {upNext.title}
                </p>
                {upNext.channel && (
                  <p className="mt-0.5 truncate text-xs text-gray-500">
                    {upNext.channel}
                  </p>
                )}
                <div
                  className={`flex flex-wrap items-center gap-3 ${
                    compactUpNext ? "mt-3" : "mt-4"
                  }`}
                >
                  <button
                    type="button"
                    onClick={onPlayUpNext}
                    className="flex-1 rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-ink-950 hover:bg-accent-soft"
                  >
                    Play now
                  </button>
                  <button
                    type="button"
                    onClick={onCancelUpNext}
                    className="ui-panel ui-interactive rounded-lg border border-ink-700 bg-ink-800 px-3 py-2 text-sm text-gray-200 hover:bg-ink-700"
                  >
                    Cancel
                  </button>
                </div>
                {onAutoplayRelatedChange && (
                  <label
                    className={`flex items-center justify-between gap-3 border-t border-ink-700 pt-3 ${
                      compactUpNext ? "mt-3" : "mt-4"
                    }`}
                  >
                    <span className="text-xs text-gray-400">Autoplay related</span>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={autoplayRelated}
                      onClick={() => onAutoplayRelatedChange(!autoplayRelated)}
                      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
                        autoplayRelated ? "bg-accent" : "bg-ink-700"
                      }`}
                    >
                      <span
                        className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${
                          autoplayRelated ? "translate-x-4" : "translate-x-0"
                        }`}
                      />
                    </button>
                  </label>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
