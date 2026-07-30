import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { absoluteUrl, api, spritesImageUrl, streamUrl } from "../api";
import PlayerOverlays from "./PlayerOverlays";
import SubtitleOverlay from "./SubtitleOverlay";
import { useAirPlay } from "../hooks/useAirPlay";
import { useChromecast } from "../hooks/useChromecast";
import { usePlaybackHealth } from "../hooks/usePlaybackHealth";
import {
  useSettings,
  type SubtitleSize,
} from "../hooks/useSettings";
import { useIsMobile } from "../hooks/useIsMobile";
import { useApplyShakaQuality, useShakaDashLoad } from "../hooks/useShakaDash";
import type { SponsorSegment } from "../hooks/useSponsorBlock";
import type { SpriteMeta } from "../types";
import { formatDuration, formatTimestamp, type Chapter } from "../utils";
import { trackQuality } from "../utils/decodeCapability";
import type {
  ShakaPlayer,
} from "shaka-player/dist/shaka-player.dash.js";

import type { StreamType, SubtitleSource, ViewMode } from "./videoPlayerTypes";
import {
  abrRestrictions,
  qualityMenuLabel,
  streamQualityToChoice,
  type QualityChoice,
} from "./videoPlayerQuality";

export type { StreamType, SubtitleSource, ViewMode } from "./videoPlayerTypes";


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
  /** Fires when the live DASH track quality changes (YouTube ladder height). */
  onActiveQualityChange?: (quality: number | null) => void;
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
  onActiveQualityChange,
}: Props) {
  const isMini = variant === "mini";
  const isMobile = useIsMobile();
  const [settings] = useSettings();
  const videoRef = useRef<HTMLVideoElement>(null);
  const shakaPlayerRef = useRef<ShakaPlayer | null>(null);
  const capabilityMaxHeightRef = useRef<number>(2160);
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
  /** PiP / iOS native fullscreen — overlay can't paint; use native cues. */
  const [nativeTextActive, setNativeTextActive] = useState(false);
  const [rate, setRate] = useState(() => snapRateToStep(defaultRate));
  const [showSpeed, setShowSpeed] = useState(false);
  const [showQuality, setShowQuality] = useState(false);
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
  const [qualityNotice, setQualityNotice] = useState<string | null>(null);
  const qualityNoticeTimer = useRef<number | null>(null);
  /** When DASH fails, switch to progressive fallback without remounting the page. */
  const [compatMode, setCompatMode] = useState(false);
  const [dashReloadToken, setDashReloadToken] = useState(0);
  const [shakaReady, setShakaReady] = useState(false);
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
    const existing = shakaPlayerRef.current;
    shakaPlayerRef.current = null;
    setShakaReady(false);
    if (existing) {
      void existing.destroy().catch(() => undefined);
    }
    setCompatMode(true);
    setMediaError(null);
    setBuffering(true);
    showQualityNotice("Reduced quality (compatibility mode)");
    return true;
  }, [progressiveFallbackSrc, showQualityNotice]);

  useEffect(() => {
    suppressedSegmentsRef.current.clear();
    prevTimeRef.current = 0;
    setSkippedSegment(null);
    setSkipNotice(null);
    setCcNotice(null);
    setMediaError(null);
    setBuffering(true);
    setCompatMode(false);
    setShakaReady(false);
    setAvailableHeights([]);
    setActiveQuality(null);
    setShowQuality(false);
    setQualityChoice(streamQualityToChoice(settings.defaultStreamQuality));
    // Seed from the setting once per src; in-player changes stay session-scoped.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional
  }, [src]);

  useShakaDashLoad({
    src,
    effectiveStreamType,
    dashReloadToken,
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        void import("../utils/decodeCapability").then((m) => m.clearDowngrade());
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
          const candidates = tracks.filter(
            (t) => trackQuality(t) <= maxHeight
          );
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
    if (
      !playing ||
      showSpeed ||
      showQuality ||
      controlsInteracting.current
    )
      return;
    hideControlsTimer.current = window.setTimeout(() => {
      setControlsVisible(false);
      hideControlsTimer.current = null;
    }, CONTROLS_HIDE_DELAY_MS);
  }, [playing, showSpeed, showQuality, clearHideControlsTimer]);

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
    if (
      isMini ||
      !playing ||
      showSpeed ||
      showQuality ||
      controlsInteracting.current
    )
      return;
    clearHideControlsTimer();
    setControlsVisible(false);
  }, [isMini, playing, showSpeed, showQuality, clearHideControlsTimer]);

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
        e.key === "ArrowUp" ||
        e.key === "ArrowDown" ||
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
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        const next = Math.min(1, Math.round((volume + 0.05) * 100) / 100);
        setVolume(next);
        setMuted(next === 0);
        if (videoRef.current) {
          videoRef.current.volume = next;
          videoRef.current.muted = next === 0;
        }
        onVolumeChange?.(next);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        const next = Math.max(0, Math.round((volume - 0.05) * 100) / 100);
        setVolume(next);
        setMuted(next === 0);
        if (videoRef.current) {
          videoRef.current.volume = next;
          videoRef.current.muted = next === 0;
        }
        onVolumeChange?.(next);
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
    volume,
    onVolumeChange,
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

    // Only suppress the click that follows a real hold-to-2x engagement.
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
    setRate(2);
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
  }, [rate, endHold]);

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
    if (showSpeed || showQuality) {
      clearHideControlsTimer();
      setControlsVisible(true);
    } else if (playing) {
      scheduleHideControls();
    }
  }, [
    isMini,
    showSpeed,
    showQuality,
    playing,
    clearHideControlsTimer,
    scheduleHideControls,
  ]);

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
    ? `relative w-full overflow-hidden bg-black leading-none${onMiniMove ? " cursor-grab active:cursor-grabbing" : ""}`
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
        <video
          ref={videoRef}
          src={effectiveStreamType === "dash" ? undefined : effectiveSrc}
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
            setMediaError(
              "This video could not be played. The file may be incomplete or corrupt."
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
          />
        )}

        <PlayerOverlays
          buffering={buffering}
          mediaError={mediaError}
          casting={chromecast.casting}
          castDeviceName={castDeviceName}
          qualityNotice={qualityNotice}
          compatMode={compatMode}
          isMini={isMini}
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
          <div
            className={`absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/95 via-black/70 to-transparent px-4 pb-2 pt-10 transition-opacity duration-300 ${
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
                <Link
                  to="/settings?tab=playback"
                  className="underline decoration-accent/50 underline-offset-2 hover:text-accent/90"
                  title="Open SponsorBlock settings"
                >
                  {skipNotice}
                </Link>
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
            <div className="mt-2 flex items-center gap-3 text-gray-100">
              <button
                onClick={togglePlay}
                className="text-xl leading-none hover:text-accent"
              >
                {playing ? "❚❚" : "►"}
              </button>

              {!isMobile && (
                <div className="flex items-center gap-2">
                  <button
                    onClick={toggleMute}
                    className="flex items-center justify-center hover:text-accent"
                    title={muted || volume === 0 ? "Unmute" : "Mute"}
                    aria-label={muted || volume === 0 ? "Unmute" : "Mute"}
                  >
                    {muted || volume === 0 ? (
                      <svg
                        viewBox="0 0 24 24"
                        className="h-4 w-4"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden
                      >
                        <path d="M11 5 6 9H2v6h4l5 4V5z" />
                        <path d="m22 9-6 6M16 9l6 6" />
                      </svg>
                    ) : (
                      <svg
                        viewBox="0 0 24 24"
                        className="h-4 w-4"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden
                      >
                        <path d="M11 5 6 9H2v6h4l5 4V5z" />
                        <path d="M15.5 8.5a5 5 0 0 1 0 7" />
                        <path d="M18.5 5.5a9 9 0 0 1 0 13" />
                      </svg>
                    )}
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
                    className="accent-scrubber w-20 sm:w-28 xl:w-36"
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
                {effectiveStreamType === "dash" &&
                  availableHeights.length > 0 && (
                    <div className="relative">
                      <button
                        type="button"
                        onClick={() => {
                          setShowSpeed(false);
                          setShowQuality((s) => !s);
                        }}
                        className={`rounded px-2 py-1 text-xs font-medium tabular-nums ${
                          qualityChoice !== "auto"
                            ? "bg-accent text-ink-950"
                            : "bg-ink-700 text-gray-200 hover:text-accent"
                        }`}
                        title="Stream quality"
                      >
                        {qualityChoice === "auto" && activeQuality
                          ? `Auto · ${qualityMenuLabel(activeQuality)}`
                          : qualityMenuLabel(qualityChoice)}
                      </button>
                      {showQuality && (
                        <div className="absolute bottom-9 right-0 z-10 w-32 rounded-lg bg-ink-800 p-2 ring-1 ring-ink-600">
                          <div className="flex flex-col gap-1">
                            <button
                              type="button"
                              onClick={() => {
                                pickQuality("auto");
                                setShowQuality(false);
                              }}
                              className={`rounded px-2 py-1.5 text-left text-[11px] font-medium ${
                                qualityChoice === "auto"
                                  ? "bg-accent text-ink-950"
                                  : "bg-ink-700 text-gray-200 hover:text-accent"
                              }`}
                            >
                              Auto
                              {activeQuality && qualityChoice === "auto"
                                ? ` · ${qualityMenuLabel(activeQuality)}`
                                : ""}
                            </button>
                            {availableHeights.map((h) => (
                              <button
                                key={h}
                                type="button"
                                onClick={() => {
                                  pickQuality(h);
                                  setShowQuality(false);
                                }}
                                className={`rounded px-2 py-1.5 text-left text-[11px] font-medium tabular-nums ${
                                  qualityChoice === h
                                    ? "bg-accent text-ink-950"
                                    : "bg-ink-700 text-gray-200 hover:text-accent"
                                }`}
                              >
                                {qualityMenuLabel(h)}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                <div className="relative">
                  <button
                    onClick={() => {
                      setShowQuality(false);
                      setShowSpeed((s) => !s);
                    }}
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
