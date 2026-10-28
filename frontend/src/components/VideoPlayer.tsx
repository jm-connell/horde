import { useCallback, useEffect, useRef, useState } from "react";
import PlayerOverlays from "./PlayerOverlays";
import { SPEED_STEPS, snapRateToStep } from "./player/constants";
import { useChapters } from "./player/useChapters";
import SkipNoticeChip from "./player/SkipNotice";
import { useSkipSegments } from "./player/useSkipSegments";
import MiniPlayerFrame from "./player/MiniPlayerFrame";
import { useMiniPlayer } from "./player/useMiniPlayer";
import ControlBar from "./player/ControlBar";
import { useFrameInset } from "./player/useFrameInset";
import { playerLayout } from "./player/playerLayout";
import { usePlayerViewMode } from "./player/usePlayerViewMode";
import { useVideoEvents } from "./player/useVideoEvents";
import { usePlayerVolume } from "./player/usePlayerVolume";
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
import { clipBarRange, clipMarkAtBar } from "./player/clipMarkers";
import { behindLive, useLiveWindow } from "./player/useLiveWindow";
import type { ShakaPlayer } from "shaka-player/dist/shaka-player.dash.js";

import type { VideoPlayerProps } from "./videoPlayerTypes";
import { resolveHotkeys } from "../hotkeys";
import UpNextOverlay from "./player/UpNextOverlay";
import { PauseIcon, PlayIcon } from "./icons";

export type { StreamType, SubtitleSource, ViewMode } from "./videoPlayerTypes";

const DEFAULT_HOTKEYS = resolveHotkeys({});

export default function VideoPlayer({
  src,
  streamType: streamTypeProp = "file",
  live = false,
  progressiveFallbackSrc: progressiveFallbackProp,
  videoId,
  storyboard = null,
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
  onLiveBehind,
  clipMarkers = null,
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
  hotkeys = DEFAULT_HOTKEYS,
  onAutoplayRelatedChange,
  onActiveQualityChange,
  onFrameInsetChange,
  mediaSuspended = false,
  blockingOverlay,
  onSourceError,
}: VideoPlayerProps) {
  const isMini = variant === "mini";
  const streamType = live ? "dash" : streamTypeProp;
  const progressiveFallbackSrc = live ? undefined : progressiveFallbackProp;
  const isMobile = useIsMobile();
  const [settings] = useSettings();
  const videoRef = useRef<HTMLVideoElement>(null);
  const shakaPlayerRef = useRef<ShakaPlayer | null>(null);
  const playerRootRef = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const { volume, muted, applyVolume, toggleMute } = usePlayerVolume(
    videoRef,
    src,
    volumeProp ?? 1,
    onVolumeChange
  );
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

  useFrameInset(onFrameInsetChange, videoRef, {
    isMini,
    isNativeFullscreen,
    mode,
    videoAspect,
  });
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
    live,
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

  const liveWindow = useLiveWindow(shakaPlayerRef, live, shakaReady);

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

  const { toggleTheater, toggleWindowed, exitWindowed } = usePlayerViewMode(
    mode,
    onModeChange
  );

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
    hideControls,
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

  usePlayerKeyboard({
    videoRef,
    mode,
    isMini,
    singleKeyShortcuts,
    hotkeys,
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

  // Phones, YouTube-style: a tap on the picture shows or hides the controls;
  // the large centre button plays and pauses.
  const touchControls = isMobile && !isMini;
  const onMobileTap = useCallback(() => {
    if (controlsVisible) hideControls();
    else revealControls();
  }, [controlsVisible, hideControls, revealControls]);

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
    onMobileTap,
  });

  const videoEvents = useVideoEvents({
    prevTimeRef,
    isSeekingRef,
    pendingSeekRef,
    handleSkipTimeUpdate: skip.handleTimeUpdate,
    streamType: effectiveStreamType,
    compatMode,
    effectiveSrc,
    mediaSuspended,
    chromecastCasting,
    setPlaying,
    setCurrent,
    setDuration,
    setVideoAspect,
    setMediaError,
    setCaptionMode,
    hideBuffering,
    scheduleBuffering,
    enterCompatMode,
    onProgress,
    onEnded,
    onSourceError,
  });

  const { wrapperClass, innerClass, miniStyle, videoClass, subtitleClass } =
    playerLayout({
      isMini,
      isMobile,
      isNativeFullscreen,
      mode,
      videoAspect,
      canMoveMini: Boolean(onMiniMove),
      subtitleSize,
    });

  // Live: the seek bar spans the DVR window, 0 = its oldest segment.
  const liveStart = liveWindow?.start ?? 0;
  const barCurrent = liveWindow
    ? Math.min(Math.max(0, current - liveStart), liveWindow.end - liveStart)
    : current;
  const barDuration = liveWindow ? liveWindow.end - liveStart : duration;
  const barSeekTo = useCallback(
    (sec: number) => seekTo(liveStart + sec),
    [seekTo, liveStart]
  );
  const goLive = useCallback(() => {
    const p = shakaPlayerRef.current;
    if (p) p.goToLive();
    else if (liveWindow) seekTo(liveWindow.end);
    videoRef.current?.play().catch(() => undefined);
  }, [liveWindow, seekTo]);
  const liveBehind = liveWindow ? behindLive(liveWindow, current) : null;
  useEffect(() => {
    if (liveBehind != null) onLiveBehind?.(liveBehind);
  }, [liveBehind, onLiveBehind]);
  const clipRange = clipMarkers
    ? clipBarRange(clipMarkers, liveWindow, Date.now())
    : null;
  const onClipMove = clipMarkers?.onMove
    ? (which: "start" | "end", barSec: number) => {
        const mark = clipMarkAtBar(barSec, live, liveWindow, Date.now());
        if (mark) clipMarkers.onMove?.(which, mark);
      }
    : undefined;
  const liveControl = live
    ? {
        behindSec: liveBehind ?? 0,
        isLive: liveWindow?.isLive ?? true,
        onGoLive: goLive,
      }
    : null;

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
        onTouchStart={
          isMini
            ? revealMiniControls
            : (e) => {
                // A tap on the picture is handled by onMobileTap on release.
                if (touchControls && e.target === videoRef.current) return;
                revealControls();
              }
        }
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
          {...videoEvents}
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
            centered={isMobile && !isMini}
            active
            onPositionChange={
              isMobile && !isMini ? undefined : onSubtitlePositionChange
            }
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

        {touchControls && !blockingOverlay && !buffering && !mediaError && (
          <button
            type="button"
            onClick={() => {
              togglePlay();
              revealControls();
            }}
            aria-label={playing ? "Pause video" : "Play video"}
            className={`absolute left-1/2 top-1/2 z-6 flex h-16 w-16 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-black/55 text-2xl leading-none text-white transition-opacity duration-300 ${
              controlsVisible ? "opacity-100" : "pointer-events-none opacity-0"
            }`}
          >
            {playing ? <PauseIcon /> : <PlayIcon />}
          </button>
        )}

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
            current={live ? barCurrent : current}
            duration={live ? barDuration : duration}
            seekTo={live ? barSeekTo : seekTo}
            live={liveControl}
            clipRange={clipRange}
            onClipMove={onClipMove}
            onInteractionStart={onControlsInteractionStart}
            onInteractionEnd={onControlsInteractionEnd}
            scrubberRef={scrubberRef}
            videoId={videoId}
            storyboard={storyboard}
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
            castAvailable={castAvailable && !live}
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
