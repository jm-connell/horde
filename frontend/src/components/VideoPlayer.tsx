import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { absoluteUrl, api, streamUrl, withMediaToken } from "../api";
import PlayerOverlays from "./PlayerOverlays";
import {
  BUFFERING_INDICATOR_DELAY_MS,
  CONTROLS_HIDE_DELAY_MS,
  HOLD_DELAY_MS,
  MAX_MINI_WIDTH,
  MIN_MINI_WIDTH,
  SPEED_STEPS,
  snapRateToStep,
} from "./player/constants";
import { useChapters } from "./player/useChapters";
import SkipNoticeChip from "./player/SkipNotice";
import { useSkipSegments } from "./player/useSkipSegments";
import ControlBar from "./player/ControlBar";
import { usePlayerMenu } from "./player/usePlayerMenu";
import { usePlayerKeyboard } from "./player/usePlayerKeyboard";
import SubtitleOverlay from "./SubtitleOverlay";
import { useAirPlay } from "../hooks/useAirPlay";
import { useChromecast } from "../hooks/useChromecast";
import { usePlaybackHealth } from "../hooks/usePlaybackHealth";
import { useSettings, type SubtitleSize } from "../hooks/useSettings";
import { useIsMobile } from "../hooks/useIsMobile";
import { useApplyShakaQuality, useShakaDashLoad } from "../hooks/useShakaDash";
import type { SponsorSegment } from "../hooks/useSponsorBlock";
import type { SponsorBlockSkipMode } from "../sponsorBlock";
import type { Chapter } from "../utils";
import { clearDowngrade, trackQuality } from "../utils/decodeCapability";
import {
  miniFrameFromNorthWestResize,
  type MiniPlayerBox,
} from "../utils/miniPlayerLayout";
import type { ShakaPlayer } from "shaka-player/dist/shaka-player.dash.js";

import type { StreamType, SubtitleSource, ViewMode } from "./videoPlayerTypes";
import {
  abrRestrictions,
  streamQualityToChoice,
  type QualityChoice,
} from "./videoPlayerQuality";

export type { StreamType, SubtitleSource, ViewMode } from "./videoPlayerTypes";

interface Props {
  src: string;
  /** Progressive local/remote file (default) or adaptive DASH manifest. */
  streamType?: StreamType;
  /**
   * Progressive (<=720p) URL used when DASH is unsupported or fails critically.
   * Typically `/api/preview/stream?url=...`.
   */
  progressiveFallbackSrc?: string;
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
  subtitleLeft?: number;
  subtitleOffset?: number;
  onSubtitlePositionChange?: (left: number, offset: number) => void;
  defaultRate?: number;
  volume?: number;
  onVolumeChange?: (volume: number) => void;
  initialPosition?: number;
  onProgress?: (sec: number) => void;
  chapters?: Chapter[];
  sponsorSegments?: SponsorSegment[];
  sponsorShowNotice?: boolean;
  sponsorSkipMode?: SponsorBlockSkipMode;
  subtitlesPending?: boolean;
  onSubtitlesRefresh?: () => void;
  miniWidth?: number | null;
  onMiniResize?: (
    width: number,
    origin: { left: number; top: number; height: number }
  ) => void;
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
  /** Letter/punctuation/Space shortcuts (WCAG 2.1.4); arrows + Escape stay on. */
  singleKeyShortcuts?: boolean;
  onAutoplayRelatedChange?: (enabled: boolean) => void;
  /** Fires when the live DASH track quality changes (YouTube ladder height). */
  onActiveQualityChange?: (quality: number | null) => void;
  /** Fires with the pillarbox inset (px) when the picture doesn't fill its box. */
  onFrameInsetChange?: (inset: number) => void;
  /**
   * Unload live media (abort DASH fetches) while keeping the player shell.
   * Used so a newly clicked preview can load without waiting on the current one.
   */
  mediaSuspended?: boolean;
  /** Covers the video (e.g. "this device can't decode AV1"); src may be "". */
  blockingOverlay?: React.ReactNode;
  /** Library file failed to decode; return true when the caller recovers. */
  onSourceError?: () => boolean;
}

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
}: Props) {
  const isMini = variant === "mini";
  const isMobile = useIsMobile();
  const [settings] = useSettings();
  const videoRef = useRef<HTMLVideoElement>(null);
  const shakaPlayerRef = useRef<ShakaPlayer | null>(null);
  const capabilityMaxHeightRef = useRef<number>(2160);
  const chromecast = useChromecast();
  const signedAirPlaySrc = useCallback(async () => {
    if (videoId == null) return null;
    const { token } = await api.getMediaToken(videoId);
    return withMediaToken(src, token);
  }, [videoId, src]);
  const airplay = useAirPlay(videoRef, src, signedAirPlaySrc);
  const autoplayRelatedId = useId();
  // Destructured so hook dependency arrays list the stable callbacks rather
  // than the whole (per-render) hook result objects.
  const {
    castMedia: castChromecastMedia,
    stop: stopChromecast,
    remotePlay: toggleChromecastPlay,
    remoteSeek: seekChromecast,
    setOnSessionEnd: setChromecastOnSessionEnd,
  } = chromecast;
  const { showPicker: showAirPlayPicker } = airplay;
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
  /** PiP / iOS native fullscreen — overlay can't paint; use native cues. */
  const [nativeTextActive, setNativeTextActive] = useState(false);
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
  const [isNativeFullscreen, setIsNativeFullscreen] = useState(false);
  const [miniControlsVisible, setMiniControlsVisible] = useState(true);
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
  const miniHideTimer = useRef<number | null>(null);
  const miniResizeDrag = useRef<{
    startX: number;
    startWidth: number;
    startBox: MiniPlayerBox;
  } | null>(null);
  const heldRate = useRef<number | null>(null);
  const holdTimer = useRef<number | null>(null);
  const holdActive = useRef(false);
  const wasPlayingBeforeHold = useRef(false);
  const suppressClick = useRef(false);
  const pointerDownOnVideo = useRef(false);

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
  const [ccNotice, setCcNotice] = useState<string | null>(null);
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

  const castAvailable = chromecast.available || airplay.available;
  const casting = chromecast.casting || airplay.casting;
  const castDeviceName = chromecast.casting
    ? chromecast.deviceName
    : airplay.casting
      ? "AirPlay"
      : null;

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
      if (!chromecast.casting) {
        el.play().catch(() => undefined);
      }
    }
  }, [
    initialPosition,
    src,
    chromecast.casting,
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
    setCcNotice(null);
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
    casting: chromecast.casting,
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

  useEffect(() => {
    setChromecastOnSessionEnd((position) => {
      const v = videoRef.current;
      if (!v) return;
      if (position > 0) {
        v.currentTime = position;
        setCurrent(position);
        onProgress?.(position);
      }
      v.play().catch(() => undefined);
    });
  }, [setChromecastOnSessionEnd, onProgress]);

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
      // The receiver fetches these itself and sends no cookie: sign them.
      const { token } = await api.getMediaToken(videoId);
      const signed = (path: string) => absoluteUrl(withMediaToken(path, token));
      await castChromecastMedia({
        contentUrl: signed(streamUrl(videoId)),
        mimeType,
        title: title ?? "Video",
        posterUrl: poster ? signed(poster) : null,
        currentTime: v.currentTime,
        subtitles: tracks.map((t) => ({
          lang: t.lang,
          src: signed(t.src),
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
    castChromecastMedia,
  ]);

  const onCastClick = useCallback(() => {
    if (chromecast.casting) {
      stopChromecast();
      return;
    }
    if (chromecast.available) {
      void startChromecast();
      return;
    }
    if (airplay.available) {
      showAirPlayPicker();
    }
  }, [
    chromecast.casting,
    chromecast.available,
    stopChromecast,
    startChromecast,
    airplay.available,
    showAirPlayPicker,
  ]);

  const setCaptionMode = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    const selected = captionLang?.toLowerCase() ?? null;
    const player = shakaPlayerRef.current;
    // Overlay paints captions in the normal player; native/Shaka text only
    // when PiP or iOS native fullscreen owns the pixels.
    const showNative = Boolean(selected) && nativeTextActive;

    if (effectiveStreamType === "dash" && player) {
      try {
        const shakaTracks = player.getTextTracks() ?? [];
        if (!selected) {
          player.setTextTrackVisibility(false);
        } else {
          const match =
            shakaTracks.find(
              (t) => (t.language || "").toLowerCase() === selected
            ) ??
            shakaTracks.find(
              (t) =>
                (t.language || "").toLowerCase().split("-")[0] ===
                selected.split("-")[0]
            );
          if (match) player.selectTextTrack(match);
          player.setTextTrackVisibility(showNative);
        }
      } catch {
        // Caption APIs can throw if the player is mid-destroy.
      }
      return;
    }

    const trackEls = Array.from(
      v.querySelectorAll("track")
    ) as HTMLTrackElement[];
    trackEls.forEach((el, i) => {
      const tt = el.track;
      if (!tt) return;
      if (!selected) {
        tt.mode = "hidden";
        return;
      }
      const metaLang = (tracks[i]?.lang ?? "").toLowerCase();
      const trackLang = (
        tt.language ||
        tt.label ||
        tracks[i]?.lang ||
        ""
      ).toLowerCase();
      const matches =
        metaLang === selected ||
        metaLang.split("-")[0] === selected.split("-")[0] ||
        trackLang === selected ||
        trackLang.split("-")[0] === selected.split("-")[0];
      // Keep matched tracks loaded (hidden) for PiP fallback; show only when needed.
      tt.mode = matches ? (showNative ? "showing" : "hidden") : "hidden";
    });
  }, [captionLang, tracks, effectiveStreamType, nativeTextActive]);

  // Load external VTTs into Shaka after DASH is ready (PiP / iOS fallback).
  useEffect(() => {
    if (effectiveStreamType !== "dash" || !shakaReady) return;
    const player = shakaPlayerRef.current;
    if (!player || tracks.length === 0) return;
    let cancelled = false;
    const loadText = async () => {
      try {
        const existing = new Set(
          (player.getTextTracks() ?? []).map((t) =>
            (t.language || "").toLowerCase()
          )
        );
        for (const t of tracks) {
          const lang = t.lang.toLowerCase();
          if (existing.has(lang) || existing.has(lang.split("-")[0])) continue;
          await player.addTextTrackAsync(
            t.src,
            t.lang,
            "subtitles",
            "text/vtt"
          );
          existing.add(lang);
        }
        if (cancelled) return;
        setCaptionMode();
      } catch {
        // Best-effort; overlay fetch is the primary path.
      }
    };
    void loadText();
    return () => {
      cancelled = true;
    };
  }, [effectiveStreamType, shakaReady, tracks, src, setCaptionMode]);

  useLayoutEffect(() => {
    setCaptionMode();
  }, [setCaptionMode, tracks, src, shakaReady]);

  useEffect(() => {
    if (playing) setCaptionMode();
  }, [playing, setCaptionMode]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onTrackLoad = () => setCaptionMode();
    v.addEventListener("loadedmetadata", onTrackLoad);
    const trackEls = Array.from(
      v.querySelectorAll("track")
    ) as HTMLTrackElement[];
    for (const el of trackEls) {
      el.addEventListener("load", onTrackLoad);
      el.addEventListener("error", onTrackLoad);
    }
    return () => {
      v.removeEventListener("loadedmetadata", onTrackLoad);
      for (const el of trackEls) {
        el.removeEventListener("load", onTrackLoad);
        el.removeEventListener("error", onTrackLoad);
      }
    };
  }, [tracks, src, setCaptionMode, effectiveStreamType, shakaReady]);

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
      if (chromecast.casting) {
        seekChromecast(t);
        return;
      }
      if (videoRef.current) videoRef.current.currentTime = t;
    },
    [chromecast.casting, seekChromecast, noteSeek]
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
    if (chromecast.casting || mediaSuspended) return;
    videoRef.current?.play().catch(() => undefined);
  }, [src, chromecast.casting, mediaSuspended]);

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
      toggleChromecastPlay();
      return;
    }
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play();
    else v.pause();
  }, [chromecast.casting, toggleChromecastPlay]);

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

  // Signal for page chrome (background effects) that a full-size player is
  // actively playing; the mini player does not count.
  useEffect(() => {
    const body = document.body;
    if (playing && !isMini) body.dataset.playerPlaying = "true";
    else delete body.dataset.playerPlaying;
    // Theater / fit-window playback covers most of the page.
    if (playing && !isMini && (mode === "theater" || mode === "windowed")) {
      body.dataset.playerCovering = "true";
    } else delete body.dataset.playerCovering;
    return () => {
      delete body.dataset.playerPlaying;
      delete body.dataset.playerCovering;
    };
  }, [playing, isMini, mode]);

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

  const enterPiP = useCallback(async () => {
    const v = videoRef.current;
    if (!v?.requestPictureInPicture) return;
    await v.requestPictureInPicture();
  }, []);

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

  // PiP and iOS native fullscreen paint via the video element — switch to native cues.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onEnterPiP = () => setNativeTextActive(true);
    const onLeavePiP = () => setNativeTextActive(false);
    v.addEventListener("enterpictureinpicture", onEnterPiP);
    v.addEventListener("leavepictureinpicture", onLeavePiP);
    return () => {
      v.removeEventListener("enterpictureinpicture", onEnterPiP);
      v.removeEventListener("leavepictureinpicture", onLeavePiP);
    };
  }, []);

  // Block iOS native fullscreen hijack unless the user tapped Fullscreen.
  // When it does enter, fall back to native cue painting.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onBeginFullscreen = () => {
      if (mode !== "windowed" && !userInitiatedFullscreen.current) {
        const el = v as HTMLVideoElement & {
          webkitExitFullscreen?: () => void;
        };
        el.webkitExitFullscreen?.();
        return;
      }
      setNativeTextActive(true);
    };
    const onEndFullscreen = () => setNativeTextActive(false);
    v.addEventListener("webkitbeginfullscreen", onBeginFullscreen);
    v.addEventListener("webkitendfullscreen", onEndFullscreen);
    return () => {
      v.removeEventListener("webkitbeginfullscreen", onBeginFullscreen);
      v.removeEventListener("webkitendfullscreen", onEndFullscreen);
    };
  }, [mode]);

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
      const rect = playerRootRef.current?.getBoundingClientRect();
      const startWidth = rect?.width ?? miniWidth ?? (isMobile ? 224 : 704);
      const startBox: MiniPlayerBox = rect
        ? {
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
          }
        : {
            left: 0,
            top: 0,
            width: startWidth,
            height: startWidth * (9 / 16),
          };
      miniResizeDrag.current = {
        startX: e.clientX,
        startWidth,
        startBox,
      };

      const onMove = (ev: PointerEvent) => {
        if (!miniResizeDrag.current || !onMiniResize) return;
        const {
          startX,
          startWidth: sw,
          startBox: box,
        } = miniResizeDrag.current;
        const nextWidth = clampMiniWidth(sw + (startX - ev.clientX));
        const frame = miniFrameFromNorthWestResize(box, nextWidth);
        onMiniResize(frame.width, {
          left: frame.left,
          top: frame.top,
          height: frame.height,
        });
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
        hit?.closest("button, input, select, textarea, a, [data-mini-no-drag]")
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
  const activeSubtitleSrc =
    captionLang == null
      ? null
      : (tracks.find(
          (t) =>
            t.lang === captionLang ||
            t.lang.toLowerCase().split("-")[0] ===
              captionLang.toLowerCase().split("-")[0]
        )?.src ?? null);

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
            if (!chromecast.casting && !mediaSuspended) {
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

        {activeSubtitleSrc && !nativeTextActive && !chromecast.casting && (
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
          casting={chromecast.casting}
          castDeviceName={castDeviceName}
          qualityNotice={qualityNotice}
          compatMode={compatMode}
          isMini={isMini}
          isPreview={streamType === "dash"}
          onRetry={retryPlayback}
        />

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
              className={`absolute inset-x-0 top-0 z-10 flex items-center gap-1 bg-gradient-to-b from-black/90 to-transparent px-2 pb-3 pt-1.5 text-gray-100 transition-opacity duration-300 ${
                miniControlsVisible
                  ? "pointer-events-auto opacity-100"
                  : "pointer-events-none opacity-0"
              }`}
            >
              <button
                type="button"
                onClick={togglePlay}
                className="flex min-h-[44px] min-w-[44px] touch-manipulation items-center justify-center text-2xl leading-none hover:text-accent"
                aria-label={playing ? "Pause" : "Play"}
              >
                {playing ? "❚❚" : "►"}
              </button>
              <span className="min-w-0 flex-1 truncate text-sm text-gray-200">
                {title}
              </span>
              {!isMobile &&
                typeof document !== "undefined" &&
                document.pictureInPictureEnabled && (
                  <button
                    type="button"
                    data-mini-no-drag
                    onClick={requestPiP}
                    className="flex min-h-[44px] shrink-0 touch-manipulation items-center justify-center rounded px-2 text-xs font-medium hover:text-accent"
                    title="Picture in picture"
                    aria-label="Picture in picture"
                  >
                    PiP
                  </button>
                )}
              <button
                type="button"
                onClick={onExpand}
                className="flex min-h-[44px] min-w-[44px] shrink-0 touch-manipulation items-center justify-center text-lg hover:text-accent"
                title="Expand"
                aria-label="Expand"
              >
                ⤢
              </button>
              <button
                type="button"
                onClick={onClose}
                className="flex min-h-[44px] min-w-[44px] shrink-0 touch-manipulation items-center justify-center text-lg hover:text-accent"
                title="Close"
                aria-label="Close"
              >
                ✕
              </button>
            </div>
          </>
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
          <div className="ui-up-next-scrim absolute inset-0 z-30 flex items-center justify-center overflow-hidden bg-black/65 p-4">
            <div
              className={`ui-panel ui-panel-legible w-full max-w-sm overflow-hidden rounded-xl border border-ink-700 bg-ink-900 shadow-2xl ring-1 ring-ink-600 ${
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
                    decoding="async"
                    width={320}
                    height={180}
                    src={upNext.poster}
                    alt=""
                    className="h-full w-full object-cover opacity-90"
                  />
                </div>
              )}
              <div
                className={
                  compactUpNext ? "min-h-0 flex-1 overflow-y-auto p-3" : "p-4"
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
                  <p className="mt-0.5 truncate text-xs text-muted">
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
                    htmlFor={autoplayRelatedId}
                    className={`flex items-center justify-between gap-3 border-t border-ink-700 pt-3 ${
                      compactUpNext ? "mt-3" : "mt-4"
                    }`}
                  >
                    <span className="text-xs text-gray-400">
                      Autoplay related
                    </span>
                    <button
                      id={autoplayRelatedId}
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
