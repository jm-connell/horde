import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useState,
  type MutableRefObject,
  type RefObject,
} from "react";
import type { ShakaPlayer } from "shaka-player/dist/shaka-player.dash.js";
import type { StreamType, SubtitleSource, ViewMode } from "../videoPlayerTypes";

interface Options {
  videoRef: RefObject<HTMLVideoElement | null>;
  shakaPlayerRef: RefObject<ShakaPlayer | null>;
  src: string;
  tracks: SubtitleSource[];
  streamType: StreamType;
  shakaReady: boolean;
  playing: boolean;
  mode: ViewMode;
  /** True while the viewer asked for native fullscreen (iOS hijack guard). */
  userInitiatedFullscreen: MutableRefObject<boolean>;
  captionLang: string | null;
  setCaptionLang: (lang: string | null) => void;
  subtitlesPending: boolean;
  onSubtitlesRefresh?: () => void;
}

/**
 * Subtitle track selection: cycling languages, applying the choice to Shaka or
 * the <track> elements, and switching to native cues while PiP or iOS native
 * fullscreen owns the pixels (the overlay can't paint there).
 */
export function useCaptions({
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
}: Options) {
  /** PiP / iOS native fullscreen — overlay can't paint; use native cues. */
  const [nativeTextActive, setNativeTextActive] = useState(false);
  /** Transient hint under the seek bar ("Subtitles still loading…"). */
  const [ccNotice, setCcNotice] = useState<string | null>(null);

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
  }, [
    captionLang,
    tracks,
    effectiveStreamType,
    nativeTextActive,
    videoRef,
    shakaPlayerRef,
  ]);

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
  }, [
    effectiveStreamType,
    shakaReady,
    tracks,
    src,
    setCaptionMode,
    shakaPlayerRef,
  ]);

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
  }, [tracks, src, setCaptionMode, effectiveStreamType, shakaReady, videoRef]);

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
  }, [
    tracks,
    captionLang,
    setCaptionLang,
    subtitlesPending,
    onSubtitlesRefresh,
  ]);

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
    // The <video> is re-keyed when the stream type changes (DASH to compat),
    // so re-bind to the element that exists now.
  }, [videoRef, effectiveStreamType]);

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
  }, [mode, videoRef, userInitiatedFullscreen, effectiveStreamType]);

  const clearCcNotice = useCallback(() => setCcNotice(null), []);

  const activeSubtitleSrc =
    captionLang == null
      ? null
      : (tracks.find(
          (t) =>
            t.lang === captionLang ||
            t.lang.toLowerCase().split("-")[0] ===
              captionLang.toLowerCase().split("-")[0]
        )?.src ?? null);

  return {
    nativeTextActive,
    ccNotice,
    clearCcNotice,
    cycleCaptions,
    setCaptionMode,
    activeSubtitleSrc,
  };
}
