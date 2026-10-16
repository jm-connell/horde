import { useCallback, useEffect, useRef, useState } from "react";
import PlayerOverlays from "./PlayerOverlays";
import {
  BUFFERING_INDICATOR_DELAY_MS,
  CONTROLS_HIDE_DELAY_MS,
  HOLD_DELAY_MS,
  SPEED_STEPS,
  snapRateToStep,
} from "./player/constants";
import { useChapters } from "./player/useChapters";
import SkipNoticeChip from "./player/SkipNotice";
import { useSkipSegments } from "./player/useSkipSegments";
import MiniPlayerFrame from "./player/MiniPlayerFrame";
import { useMiniPlayer } from "./player/useMiniPlayer";
import ControlBar from "./player/ControlBar";
import { useFullscreen } from "./player/useFullscreen";
import { usePictureInPicture } from "./player/usePictureInPicture";
import { usePlayerBodyFlags } from "./player/usePlayerBodyFlags";
import { useCaptions } from "./player/useCaptions";
import { useCasting } from "./player/useCasting";
import { usePlayerMenu } from "./player/usePlayerMenu";
import { usePlayerKeyboard } from "./player/usePlayerKeyboard";
import SubtitleOverlay from "./SubtitleOverlay";
import { usePlaybackHealth } from "../hooks/usePlaybackHealth";
import { useSettings } from "../hooks/useSettings";
import { useIsMobile } from "../hooks/useIsMobile";
import { useApplyShakaQuality, useShakaDashLoad } from "../hooks/useShakaDash";
import { clearDowngrade, trackQuality } from "../utils/decodeCapability";
import type { ShakaPlayer } from "shaka-player/dist/shaka-player.dash.js";

import type {
  StreamType,
  ViewMode,
  VideoPlayerProps,
} from "./videoPlayerTypes";
import UpNextOverlay from "./player/UpNextOverlay";
import {
  abrRestrictions,
  streamQualityToChoice,
  type QualityChoice,
} from "./videoPlayerQuality";

export type { StreamType, SubtitleSource, ViewMode } from "./videoPlayerTypes";

export default function VideoPlayer({
  src,
  streamType = "file",
  progressiveFallbackSrc,
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
  subtitleLeft = 20,
  subtitleOffset = 12,
  onSubtitlePositionChange,
  defaultRate = 1,
  volume: volumeProp,
  onVolumeChange,
  initialPosition = 0,
  onProgress,
  chapters = [],
  sponsorSegments = [],
  sponsorShowNotice = true,
  sponsorSkipMode = "auto",
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
  singleKeyShortcuts = true,
  onAutoplayRelatedChange,
  onActiveQualityChange,
  onFrameInsetChange,
  mediaSuspended = false,
  blockingOverlay,
  onSourceError,
}: VideoPlayerProps) {
  const isMini = variant === "mini";
  const isMobile = useIsMobile();
  const [settings] = useSettings();
  const videoRef = useRef<HTMLVideoElement>(null);
  const shakaPlayerRef = useRef<ShakaPlayer | null>(null);
  const capabilityMaxHeightRef = useRef<number>(2160);
  const playerRootRef = useRef<HTMLDivElement>(null);
  const hideControlsTimer = useRef<number | null>(null);
  const controlsInteracting = useRef(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(volumeProp ?? 1);
  const [muted, setMuted] = useState(false);
  const [captionLang, setCaptionLang] = useState<string | null>(null);
  const {
    available: castAvailable,
    casting,
    chromecastCasting,
    deviceName: castDeviceName,
    onCastClick,
    toggleChromecastPlay,
    seekChromecast,
  } = useCasting({
    videoRef,
    videoId,
    src,
    mimeType,
    title,
    poster,
    tracks,
    captionLang,
    onProgress,
    setCurrent,
    setDuration,
    setPlaying,
  });
  const [rate, setRate] = useState(() => snapRateToStep(defaultRate));
  const { openMenu, menuOpen, toggleMenu, closeMenu } = usePlayerMenu();
  const [qualityChoice, setQualityChoice] = useState<QualityChoice>(() =>
    streamQualityToChoice(settings.defaultStreamQuality)
  );
  /** Distinct short-side qualities (min(w,h)), not raw frame heights. */
  const [availableHeights, setAvailableHeights] = useState<number[]>([]);
  /** Live ABR / selected track quality (YouTube ladder), when known. */
  const [activeQuality, setActiveQuality] = useState<number | null>(null);
  const qualityChoiceRef = useRef(qualityChoice);
  qualityChoiceRef.current = qualityChoice;
  const variantTracksRef = useRef<
    {
      width?: number | null;
      height?: number | null;
      bandwidth?: number;
    }[]
  >([]);
  const {
    isNativeFullscreen,
    toggleNativeFullscreen,
    userInitiatedFullscreen,
  } = useFullscreen(playerRootRef, videoRef);
  const { requestPiP } = usePictureInPicture(videoRef, isMobile);
  usePlayerBodyFlags(playing, isMini, mode);
  const [videoAspect, setVideoAspect] = useState<number | null>(null);

  // Theater mode stretches the player edge-to-edge, but object-contain
  // pillarboxes the picture when its aspect is narrower than the viewport;
  // report that inset so the nav bar can line up with the visible frame.
  useEffect(() => {
    if (!onFrameInsetChange) return;
    if (isMini || isNativeFullscreen || mode === "windowed") {
      onFrameInsetChange(0);
      return;
    }
    const el = videoRef.current;
    if (!el) return;
    const compute = () => {
      const rect = el.getBoundingClientRect();
      if (!videoAspect || rect.width <= 0 || rect.height <= 0) {
        onFrameInsetChange(0);
        return;
      }
      const boxAspect = rect.width / rect.height;
      const inset =
        boxAspect > videoAspect
          ? Math.max(0, (rect.width - rect.height * videoAspect) / 2)
          : 0;
      onFrameInsetChange(inset);
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    window.addEventListener("resize", compute);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", compute);
    };
  }, [onFrameInsetChange, isMini, isNativeFullscreen, mode, videoAspect]);
  const heldRate = useRef<number | null>(null);
  const holdTimer = useRef<number | null>(null);
  const holdActive = useRef(false);
  const wasPlayingBeforeHold = useRef(false);
  const suppressClick = useRef(false);
  const pointerDownOnVideo = useRef(false);
  const {
    miniControlsVisible,
    revealMiniControls,
    onMiniResizePointerDown,
    onMiniMovePointerDown,
  } = useMiniPlayer({
    isMini,
    playing,
    isMobile,
    playerRootRef,
    suppressClick,
    miniWidth,
    onMiniResize,
    onMiniMove,
    onMiniMoveEnd,
  });

  const prevTimeRef = useRef(0);
  const isSeekingRef = useRef(false);
  const skip = useSkipSegments({
    videoRef,
    prevTimeRef,
    isSeekingRef,
    sponsorSegments,
    sponsorSkipMode,
    sponsorShowNotice,
  });
  const { noteSeek } = skip;
  const pendingSeekRef = useRef(initialPosition);
  const [buffering, setBuffering] = useState(true);
  const bufferingShowTimer = useRef<number | null>(null);
  const mediaSuspendedRef = useRef(mediaSuspended);
  mediaSuspendedRef.current = mediaSuspended;

  const hideBuffering = useCallback(() => {
    if (mediaSuspendedRef.current) return;
    if (bufferingShowTimer.current != null) {
      window.clearTimeout(bufferingShowTimer.current);
      bufferingShowTimer.current = null;
    }
    setBuffering(false);
  }, []);

  const scheduleBuffering = useCallback(() => {
    const el = videoRef.current;
    if (!el || el.paused || el.ended || isSeekingRef.current) return;
    if (el.readyState >= HTMLMediaElement.HAVE_ENOUGH_DATA) return;
    if (bufferingShowTimer.current != null) return;
    bufferingShowTimer.current = window.setTimeout(() => {
      bufferingShowTimer.current = null;
      const v = videoRef.current;
      if (!v || v.paused || v.ended || isSeekingRef.current) return;
      if (v.readyState >= HTMLMediaElement.HAVE_ENOUGH_DATA) return;
      setBuffering(true);
    }, BUFFERING_INDICATOR_DELAY_MS);
  }, []);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [qualityNotice, setQualityNotice] = useState<string | null>(null);
  const qualityNoticeTimer = useRef<number | null>(null);
  /** When DASH fails, switch to progressive fallback without remounting the page. */
  const [compatMode, setCompatMode] = useState(false);
  const [dashReloadToken, setDashReloadToken] = useState(0);
  const [shakaReady, setShakaReady] = useState(false);
  const { hoveredChapter, setHoveredChapterSec, nextChapterStart } =
    useChapters(chapters);
  const scrubberRef = useRef<HTMLDivElement>(null);

  const effectiveStreamType: StreamType =
    compatMode || streamType !== "dash" ? "file" : "dash";
  const effectiveSrc =
    compatMode && progressiveFallbackSrc ? progressiveFallbackSrc : src;

  useEffect(() => {
    pendingSeekRef.current = initialPosition;
    const el = videoRef.current;
    if (!el || initialPosition <= 1) return;
    // Do not treat a leftover Shaka MediaSource as "already loaded" file
    // metadata — seeking/playing on it hangs after preview → library handoff.
    if (el.srcObject) return;
    if (effectiveStreamType === "dash") return;
    if (mediaSuspended) return;
    if (
      el.readyState >= 1 &&
      Number.isFinite(el.duration) &&
      initialPosition < el.duration
    ) {
      if (Math.abs(el.currentTime - initialPosition) > 1.25) {
        el.currentTime = initialPosition;
      }
      pendingSeekRef.current = 0;
      if (!chromecastCasting) {
        el.play().catch(() => undefined);
      }
    }
  }, [
    initialPosition,
    src,
    chromecastCasting,
    effectiveStreamType,
    mediaSuspended,
  ]);

  const showQualityNotice = useCallback((msg: string) => {
    setQualityNotice(msg);
    if (qualityNoticeTimer.current !== null) {
      clearTimeout(qualityNoticeTimer.current);
    }
    qualityNoticeTimer.current = window.setTimeout(() => {
      setQualityNotice(null);
      qualityNoticeTimer.current = null;
    }, 4000);
  }, []);

  const enterCompatMode = useCallback(() => {
    if (!progressiveFallbackSrc) return false;
    const el = videoRef.current;
    if (el && Number.isFinite(el.currentTime) && el.currentTime > 1) {
      pendingSeekRef.current = el.currentTime;
    }
    // Drop the ref so the DASH effect cleanup owns destroy(). The <video>
    // key switches with effectiveStreamType so the MSE element is not reused.
    shakaPlayerRef.current = null;
    setShakaReady(false);
    setCompatMode(true);
    setMediaError(null);
    setBuffering(true);
    showQualityNotice("Reduced quality (compatibility mode)");
    return true;
  }, [progressiveFallbackSrc, showQualityNotice]);

  useEffect(() => {
    skip.reset();
    prevTimeRef.current = 0;
    clearCcNotice();
    setMediaError(null);
    if (bufferingShowTimer.current != null) {
      window.clearTimeout(bufferingShowTimer.current);
      bufferingShowTimer.current = null;
    }
    setBuffering(true);
    setCompatMode(false);
    setShakaReady(false);
    setAvailableHeights([]);
    setActiveQuality(null);
    closeMenu("quality");
    setQualityChoice(streamQualityToChoice(settings.defaultStreamQuality));
    // Seed from the setting once per src; in-player changes stay session-scoped.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- seed once per src; later setting changes must not reset the in-player choice
  }, [src]);

  useEffect(() => {
    if (!mediaSuspended) return;
    setBuffering(true);
    setPlaying(false);
    videoRef.current?.pause();
  }, [mediaSuspended]);

  useEffect(() => {
    return () => {
      if (bufferingShowTimer.current != null) {
        window.clearTimeout(bufferingShowTimer.current);
      }
    };
  }, []);

  useShakaDashLoad({
    src,
    effectiveStreamType,
    dashReloadToken,
    mediaSuspended,
    videoRef,
    shakaPlayerRef,
    qualityChoiceRef,
    capabilityMaxHeightRef,
    variantTracksRef,
    casting: chromecastCasting,
    enterCompatMode,
    setShakaReady,
    setAvailableHeights,
    setQualityChoice,
    setMediaError,
    setBuffering,
  });

  // Keep the quality chip honest: Auto often sits well below the ladder ceiling.
  useEffect(() => {
    if (effectiveStreamType !== "dash" || !shakaReady) {
      setActiveQuality(null);
      onActiveQualityChange?.(null);
      return;
    }
    const p = shakaPlayerRef.current;
    if (!p) return;

    const sync = () => {
      try {
        const tracks = p.getVariantTracks() ?? [];
        variantTracksRef.current = tracks;
        const active = tracks.find((t) => t.active);
        const q = active ? trackQuality(active) : null;
        setActiveQuality(q);
        onActiveQualityChange?.(q);
      } catch {
        // player may be mid-destroy
      }
    };
    sync();
    p.addEventListener("adaptation", sync);
    p.addEventListener("variantchanged", sync);
    const id = window.setInterval(sync, 2500);
    return () => {
      p.removeEventListener("adaptation", sync);
      p.removeEventListener("variantchanged", sync);
      window.clearInterval(id);
    };
    // onActiveQualityChange is stable enough via PlaybackContext setter
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onActiveQualityChange is a stable setter; re-subscribing on its identity would reset the poll
  }, [effectiveStreamType, shakaReady, dashReloadToken, src]);

  // Progressive / compat: report video element's decoded size when known.
  useEffect(() => {
    if (effectiveStreamType === "dash" && !compatMode) return;
    const el = videoRef.current;
    if (!el) {
      onActiveQualityChange?.(null);
      return;
    }
    const sync = () => {
      const q = trackQuality({
        width: el.videoWidth || null,
        height: el.videoHeight || null,
      });
      const next = q > 0 ? q : null;
      setActiveQuality(next);
      onActiveQualityChange?.(next);
    };
    sync();
    el.addEventListener("loadedmetadata", sync);
    el.addEventListener("resize", sync);
    return () => {
      el.removeEventListener("loadedmetadata", sync);
      el.removeEventListener("resize", sync);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onActiveQualityChange is a stable setter; listeners re-bind only per stream/src
  }, [effectiveStreamType, compatMode, src]);

  const applyQualityChoice = useApplyShakaQuality(
    shakaPlayerRef,
    capabilityMaxHeightRef,
    variantTracksRef,
    setQualityChoice
  );

  const pickQuality = useCallback(
    (choice: QualityChoice) => {
      // Explicit ladder picks override a persisted auto-downgrade / AV1 blacklist.
      if (choice !== "auto") {
        clearDowngrade();
        capabilityMaxHeightRef.current = Math.max(
          capabilityMaxHeightRef.current,
          typeof choice === "number" ? choice : 2160
        );
      }
      applyQualityChoice(choice);
    },
    [applyQualityChoice]
  );

  usePlaybackHealth({
    enabled: effectiveStreamType === "dash" && shakaReady,
    player: shakaReady ? shakaPlayerRef.current : null,
    onDowngrade: ({ maxHeight, blacklistAv1, notice }) => {
      const p = shakaPlayerRef.current;
      if (!p) return;
      capabilityMaxHeightRef.current = Math.min(
        capabilityMaxHeightRef.current,
        maxHeight
      );
      // Relabel the menu to the new ceiling so UI matches what can play.
      setQualityChoice(maxHeight);
      try {
        if (blacklistAv1) {
          // Codec family change needs a reload so Shaka re-filters AdaptationSets.
          // readDowngrade() is consulted on the next load.
          const t = videoRef.current?.currentTime ?? 0;
          if (t > 1) pendingSeekRef.current = t;
          setDashReloadToken((n) => n + 1);
        } else {
          const tracks = p.getVariantTracks() ?? [];
          variantTracksRef.current = tracks;
          p.configure({
            abr: { enabled: false },
            restrictions: abrRestrictions(maxHeight, tracks),
          });
          const candidates = tracks.filter((t) => trackQuality(t) <= maxHeight);
          candidates.sort((a, b) => {
            const qa = trackQuality(a);
            const qb = trackQuality(b);
            if (qb !== qa) return qb - qa;
            return (b.bandwidth ?? 0) - (a.bandwidth ?? 0);
          });
          if (candidates[0]) {
            p.selectVariantTrack(candidates[0], true);
          }
        }
      } catch (err) {
        console.warn("[preview-health] configure failed", err);
      }
      showQualityNotice(notice);
    },
  });

  const retryPlayback = useCallback(() => {
    setMediaError(null);
    setBuffering(true);
    if (effectiveStreamType === "dash" && shakaPlayerRef.current) {
      try {
        const ok = shakaPlayerRef.current.retryStreaming();
        if (ok) return;
      } catch {
        // fall through to full reload
      }
      setDashReloadToken((n) => n + 1);
      return;
    }
    const el = videoRef.current;
    if (el) {
      el.load();
      el.play().catch(() => undefined);
    }
  }, [effectiveStreamType]);

  const {
    nativeTextActive,
    ccNotice,
    clearCcNotice,
    cycleCaptions,
    setCaptionMode,
    activeSubtitleSrc,
  } = useCaptions({
    videoRef,
    shakaPlayerRef,
    src,
    tracks,
    streamType: effectiveStreamType,
    shakaReady,
    playing,
    mode,
    userInitiatedFullscreen,
    captionLang,
    setCaptionLang,
    subtitlesPending,
    onSubtitlesRefresh,
  });

  const seekTo = useCallback(
    (sec: number) => {
      const t = Math.max(0, sec);
      const from = Math.max(
        videoRef.current?.currentTime ?? 0,
        prevTimeRef.current
      );
      noteSeek(from, t);
      isSeekingRef.current = true;
      prevTimeRef.current = t;
      setCurrent(t);
      if (chromecastCasting) {
        seekChromecast(t);
        return;
      }
      if (videoRef.current) videoRef.current.currentTime = t;
    },
    [chromecastCasting, seekChromecast, noteSeek]
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-apply the stored volume to each new source only; live volume changes are applied by the slider handlers
  }, [src]);

  useEffect(() => {
    if (chromecastCasting || mediaSuspended) return;
    videoRef.current?.play().catch(() => undefined);
  }, [src, chromecastCasting, mediaSuspended]);

  const togglePlay = useCallback(() => {
    if (suppressClick.current) return;
    if (chromecastCasting) {
      toggleChromecastPlay();
      return;
    }
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play();
    else v.pause();
  }, [chromecastCasting, toggleChromecastPlay]);

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
    if (!playing || menuOpen || controlsInteracting.current) return;
    hideControlsTimer.current = window.setTimeout(() => {
      setControlsVisible(false);
      hideControlsTimer.current = null;
    }, CONTROLS_HIDE_DELAY_MS);
  }, [playing, menuOpen, clearHideControlsTimer]);

  const revealControls = useCallback(() => {
    setControlsVisible(true);
    scheduleHideControls();
  }, [scheduleHideControls]);

  const onPlayerMouseMove = useCallback(() => {
    if (isMini) {
      revealMiniControls();
      return;
    }
    revealControls();
  }, [isMini, revealControls, revealMiniControls]);

  const onPlayerMouseLeave = useCallback(() => {
    if (isMini || !playing || menuOpen || controlsInteracting.current) return;
    clearHideControlsTimer();
    setControlsVisible(false);
  }, [isMini, playing, menuOpen, clearHideControlsTimer]);

  const onControlsInteractionStart = useCallback(() => {
    controlsInteracting.current = true;
    clearHideControlsTimer();
    setControlsVisible(true);
  }, [clearHideControlsTimer]);

  const onControlsInteractionEnd = useCallback(() => {
    controlsInteracting.current = false;
    scheduleHideControls();
  }, [scheduleHideControls]);

  const applyVolume = useCallback(
    (value: number, persist: boolean) => {
      setVolume(value);
      setMuted(value === 0);
      if (videoRef.current) {
        videoRef.current.volume = value;
        videoRef.current.muted = value === 0;
      }
      if (persist) onVolumeChange?.(value);
    },
    [onVolumeChange]
  );

  const exitWindowed = useCallback(() => {
    onModeChange(modeBeforeWindowed.current);
  }, [onModeChange]);

  usePlayerKeyboard({
    videoRef,
    mode,
    isMini,
    singleKeyShortcuts,
    volume,
    hasChapters: chapters.length > 0,
    togglePlay,
    toggleTheater,
    toggleWindowed,
    exitWindowed,
    cycleCaptions,
    seekTo,
    nextChapterStart,
    applyVolume,
    stepRate,
    revealControls,
  });

  const toggleMute = () => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = !v.muted;
    setMuted(v.muted);
  };

  const holdWindowCleanup = useRef<(() => void) | null>(null);

  const endHold = useCallback(() => {
    if (holdTimer.current !== null) {
      clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
    holdWindowCleanup.current?.();

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

    // Only suppress the click that follows a real hold-to-speedup engagement.
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

  const activateHold = useCallback(() => {
    const v = videoRef.current;
    if (!v || heldRate.current !== null) return;
    holdActive.current = true;
    wasPlayingBeforeHold.current = !v.paused;
    heldRate.current = rate;
    setRate(settings.holdPlaybackRate);
    if (v.paused) v.play().catch(() => undefined);

    // End hold if pointer is released outside the video element.
    holdWindowCleanup.current?.();
    const onWinPointerUp = () => endHold();
    const onWinBlur = () => endHold();
    window.addEventListener("pointerup", onWinPointerUp);
    window.addEventListener("pointercancel", onWinPointerUp);
    window.addEventListener("blur", onWinBlur);
    holdWindowCleanup.current = () => {
      window.removeEventListener("pointerup", onWinPointerUp);
      window.removeEventListener("pointercancel", onWinPointerUp);
      window.removeEventListener("blur", onWinBlur);
      holdWindowCleanup.current = null;
    };
  }, [rate, endHold, settings.holdPlaybackRate]);

  useEffect(() => {
    return () => {
      holdWindowCleanup.current?.();
      if (holdTimer.current !== null) {
        clearTimeout(holdTimer.current);
        holdTimer.current = null;
      }
    };
  }, []);

  const onVideoPointerDown = useCallback(
    (e: React.PointerEvent<HTMLVideoElement>) => {
      if (isMini) return;
      pointerDownOnVideo.current = true;
      if (e.pointerType === "touch") {
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          // ignore
        }
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
    if (menuOpen) {
      clearHideControlsTimer();
      setControlsVisible(true);
    } else if (playing) {
      scheduleHideControls();
    }
  }, [isMini, menuOpen, playing, clearHideControlsTimer, scheduleHideControls]);

  useEffect(() => () => clearHideControlsTimer(), [clearHideControlsTimer]);

  const wrapperClass = isMini
    ? `player-mini relative w-full overflow-hidden bg-black leading-none${onMiniMove ? " cursor-grab active:cursor-grabbing" : ""}`
    : isNativeFullscreen
      ? "relative flex h-full w-full items-center justify-center overflow-hidden bg-black leading-none"
      : mode === "windowed"
        ? "relative flex h-full w-full items-center justify-center overflow-hidden bg-black leading-none"
        : "relative w-full overflow-hidden bg-black leading-none";

  const innerClass =
    !isMini && (mode === "windowed" || isNativeFullscreen)
      ? "relative h-full w-full leading-none"
      : "relative w-full leading-none";

  const miniStyle =
    isMini && videoAspect
      ? { aspectRatio: `${videoAspect}` as const }
      : isMini
        ? { aspectRatio: "16 / 9" as const }
        : undefined;

  const videoClass = isMini
    ? "block h-full w-full bg-black object-contain"
    : isNativeFullscreen || mode === "windowed"
      ? "block h-full w-full object-contain"
      : isMobile
        ? "mx-auto block max-h-[70vh] w-full bg-black object-contain"
        : "mx-auto block max-h-[85vh] w-full bg-black object-contain";
  const subtitleClass = `sub-${subtitleSize}`;

  // Ultrawide (e.g. 2:1) letterboxes inside a 16:9 dock — compact the up-next
  // card so it stays within the visible video picture.
  const compactUpNext = videoAspect != null && videoAspect >= 2.0;

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
        {/* eslint-disable-next-line jsx-a11y/media-has-caption -- subtitle <track>s are rendered per available language below; the rule only recognises a static kind="captions" */}
        <video
          key={effectiveStreamType === "dash" ? "dash" : "file"}
          ref={videoRef}
          src={
            effectiveStreamType === "dash"
              ? undefined
              : effectiveSrc || undefined
          }
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
            if (t > prev + 0.02 && !e.currentTarget.paused) {
              hideBuffering();
            }
            skip.handleTimeUpdate(e.currentTarget, t, prev);
          }}
          onSeeked={() => {
            isSeekingRef.current = false;
            hideBuffering();
          }}
          onSeeking={() => {
            isSeekingRef.current = true;
          }}
          onWaiting={scheduleBuffering}
          onPlaying={hideBuffering}
          onCanPlay={hideBuffering}
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
            if (!chromecastCasting && !mediaSuspended) {
              el.play().catch(() => undefined);
            }
          }}
          onEnded={onEnded}
          onError={() => {
            hideBuffering();
            if (effectiveStreamType === "dash") {
              if (enterCompatMode()) return;
              setMediaError(
                "The preview stream failed. Check your connection and try again."
              );
              return;
            }
            if (compatMode) {
              setMediaError(
                "Compatibility-mode preview failed. Try again or download the video."
              );
              return;
            }
            if (!effectiveSrc || onSourceError?.()) return;
            setMediaError(
              "This video could not be played. Check your connection and try again."
            );
          }}
          onPointerDown={isMini ? undefined : onVideoPointerDown}
          onPointerUp={isMini ? undefined : onVideoPointerUp}
          onPointerCancel={isMini ? undefined : onVideoPointerCancel}
          onMouseLeave={isMini ? undefined : endHold}
          className={`${videoClass} ${subtitleClass}`}
        >
          {/* Kept for PiP / iOS native-fullscreen fallback; overlay paints normally. */}
          {effectiveStreamType !== "dash" &&
            tracks.map((t) => (
              <track
                key={`${effectiveSrc}-${t.lang}`}
                kind="subtitles"
                src={t.src}
                srcLang={t.lang}
                label={t.lang}
              />
            ))}
        </video>

        {activeSubtitleSrc && !nativeTextActive && !chromecastCasting && (
          <SubtitleOverlay
            videoRef={videoRef}
            src={activeSubtitleSrc}
            size={subtitleSize}
            left={subtitleLeft}
            offset={subtitleOffset}
            active
            onPositionChange={onSubtitlePositionChange}
            timelineRef={isMini ? undefined : scrubberRef}
            controlsVisible={!isMini && controlsVisible}
          />
        )}

        {blockingOverlay}

        <PlayerOverlays
          buffering={buffering && !blockingOverlay}
          mediaError={mediaError}
          casting={chromecastCasting}
          castDeviceName={castDeviceName}
          qualityNotice={qualityNotice}
          compatMode={compatMode}
          isMini={isMini}
          isPreview={streamType === "dash"}
          onRetry={retryPlayback}
        />

        {isMini ? (
          <MiniPlayerFrame
            title={title}
            playing={playing}
            isMobile={isMobile}
            controlsVisible={miniControlsVisible}
            togglePlay={togglePlay}
            onTogglePiP={requestPiP}
            onExpand={onExpand}
            onClose={onClose}
            onResizePointerDown={
              onMiniResize ? onMiniResizePointerDown : undefined
            }
          />
        ) : (
          <ControlBar
            visible={controlsVisible}
            isMobile={isMobile}
            mode={mode}
            playing={playing}
            togglePlay={togglePlay}
            current={current}
            duration={duration}
            seekTo={seekTo}
            onInteractionStart={onControlsInteractionStart}
            onInteractionEnd={onControlsInteractionEnd}
            scrubberRef={scrubberRef}
            videoId={videoId}
            chapters={chapters}
            hoveredChapter={hoveredChapter}
            onHoverChapter={setHoveredChapterSec}
            volume={volume}
            muted={muted}
            applyVolume={applyVolume}
            onVolumeChange={onVolumeChange}
            toggleMute={toggleMute}
            openMenu={openMenu}
            onToggleMenu={toggleMenu}
            onCloseMenu={closeMenu}
            rate={rate}
            onRateChange={setRate}
            streamType={effectiveStreamType}
            qualityChoice={qualityChoice}
            activeQuality={activeQuality}
            availableHeights={availableHeights}
            onPickQuality={pickQuality}
            ccNotice={ccNotice}
            showCaptionsButton={tracks.length > 0 || subtitlesPending}
            subtitlesPending={subtitlesPending}
            hasTracks={tracks.length > 0}
            captionsOn={Boolean(captionLang)}
            onCycleCaptions={cycleCaptions}
            castAvailable={castAvailable}
            casting={casting}
            castDeviceName={castDeviceName}
            onCastClick={onCastClick}
            onTogglePiP={requestPiP}
            onToggleTheater={toggleTheater}
            onToggleWindowed={toggleWindowed}
            isNativeFullscreen={isNativeFullscreen}
            onToggleFullscreen={toggleNativeFullscreen}
          />
        )}

        {skip.notice && (
          <SkipNoticeChip
            notice={skip.notice}
            isMini={isMini}
            controlsVisible={controlsVisible}
            onSkip={skip.skipPromptedSegment}
            onUndo={skip.undoSkip}
          />
        )}

        {upNext && !isMini && (
          <UpNextOverlay
            upNext={upNext}
            compact={compactUpNext}
            autoplayRelated={autoplayRelated}
            onAutoplayRelatedChange={onAutoplayRelatedChange}
            onPlayNow={onPlayUpNext}
            onCancel={onCancelUpNext}
          />
        )}
      </div>
    </div>
  );
}
