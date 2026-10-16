import { useCallback, useEffect, useRef, useState } from "react";
import PlayerOverlays from "./PlayerOverlays";
import { SPEED_STEPS, snapRateToStep } from "./player/constants";
import { useChapters } from "./player/useChapters";
import SkipNoticeChip from "./player/SkipNotice";
import { useSkipSegments } from "./player/useSkipSegments";
import MiniPlayerFrame from "./player/MiniPlayerFrame";
import { useMiniPlayer } from "./player/useMiniPlayer";
import ControlBar from "./player/ControlBar";
import { usePlayerSource } from "./player/usePlayerSource";
import { useStreamQuality } from "./player/useStreamQuality";
import { useControlsVisibility } from "./player/useControlsVisibility";
import { useHoldToSpeed } from "./player/useHoldToSpeed";
import { useFullscreen } from "./player/useFullscreen";
import { usePictureInPicture } from "./player/usePictureInPicture";
import { usePlayerBodyFlags } from "./player/usePlayerBodyFlags";
import { useCaptions } from "./player/useCaptions";
import { useCasting } from "./player/useCasting";
import { usePlayerMenu } from "./player/usePlayerMenu";
import { usePlayerKeyboard } from "./player/usePlayerKeyboard";
import SubtitleOverlay from "./SubtitleOverlay";
import { useSettings } from "../hooks/useSettings";
import { useIsMobile } from "../hooks/useIsMobile";
import { useShakaDashLoad } from "../hooks/useShakaDash";
import type { ShakaPlayer } from "shaka-player/dist/shaka-player.dash.js";

import type { ViewMode, VideoPlayerProps } from "./videoPlayerTypes";
import UpNextOverlay from "./player/UpNextOverlay";

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
  const playerRootRef = useRef<HTMLDivElement>(null);
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
  const suppressClick = useRef(false);
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
  const { hoveredChapter, setHoveredChapterSec, nextChapterStart } =
    useChapters(chapters);
  const scrubberRef = useRef<HTMLDivElement>(null);

  const {
    effectiveStreamType,
    effectiveSrc,
    compatMode,
    shakaReady,
    setShakaReady,
    dashReloadToken,
    setDashReloadToken,
    pendingSeekRef,
    buffering,
    setBuffering,
    hideBuffering,
    scheduleBuffering,
    mediaError,
    setMediaError,
    qualityNotice,
    showQualityNotice,
    enterCompatMode,
    retryPlayback,
    resetSource,
  } = usePlayerSource({
    videoRef,
    shakaPlayerRef,
    isSeekingRef,
    src,
    streamType,
    progressiveFallbackSrc,
    initialPosition,
    mediaSuspended,
    casting: chromecastCasting,
  });

  const {
    qualityChoice,
    setQualityChoice,
    qualityChoiceRef,
    availableHeights,
    setAvailableHeights,
    activeQuality,
    capabilityMaxHeightRef,
    variantTracksRef,
    pickQuality,
    resetQuality,
  } = useStreamQuality({
    videoRef,
    shakaPlayerRef,
    src,
    streamType: effectiveStreamType,
    compatMode,
    shakaReady,
    dashReloadToken,
    setDashReloadToken,
    pendingSeekRef,
    defaultStreamQuality: settings.defaultStreamQuality,
    showQualityNotice,
    onActiveQualityChange,
  });

  useEffect(() => {
    skip.reset();
    prevTimeRef.current = 0;
    clearCcNotice();
    resetSource();
    resetQuality();
    closeMenu("quality");
    // Seed from the setting once per src; in-player changes stay session-scoped.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- seed once per src; later setting changes must not reset the in-player choice
  }, [src]);

  useEffect(() => {
    if (!mediaSuspended) return;
    setBuffering(true);
    setPlaying(false);
    videoRef.current?.pause();
  }, [mediaSuspended, setBuffering]);

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

  const {
    controlsVisible,
    revealControls,
    onPlayerMouseMove,
    onPlayerMouseLeave,
    onControlsInteractionStart,
    onControlsInteractionEnd,
  } = useControlsVisibility({
    isMini,
    playing,
    menuOpen,
    revealMiniControls,
  });

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

  const {
    endHold,
    onVideoPointerDown,
    onVideoPointerUp,
    onVideoPointerCancel,
    onVideoClick,
  } = useHoldToSpeed({
    videoRef,
    isMini,
    isMobile,
    rate,
    setRate,
    holdPlaybackRate: settings.holdPlaybackRate,
    suppressClick,
    togglePlay,
  });

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
