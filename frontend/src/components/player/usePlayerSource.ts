import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
  type RefObject,
} from "react";
import type { ShakaPlayer } from "shaka-player/dist/shaka-player.dash.js";
import type { StreamType } from "../videoPlayerTypes";
import { BUFFERING_INDICATOR_DELAY_MS } from "./constants";

interface Options {
  videoRef: RefObject<HTMLVideoElement | null>;
  shakaPlayerRef: MutableRefObject<ShakaPlayer | null>;
  isSeekingRef: RefObject<boolean>;
  src: string;
  streamType: StreamType;
  /** Progressive URL to fall back to when DASH fails. */
  progressiveFallbackSrc?: string;
  initialPosition: number;
  mediaSuspended: boolean;
  casting: boolean;
}

/**
 * What is loaded and how healthy it is: DASH vs progressive (with the switch
 * to compatibility mode when DASH fails), the buffering indicator, media
 * errors and retry, and the position to resume from once metadata arrives.
 */
export function usePlayerSource({
  videoRef,
  shakaPlayerRef,
  isSeekingRef,
  src,
  streamType,
  progressiveFallbackSrc,
  initialPosition,
  mediaSuspended,
  casting,
}: Options) {
  const pendingSeekRef = useRef(initialPosition);
  const [buffering, setBuffering] = useState(true);
  const bufferingShowTimer = useRef<number | null>(null);
  const mediaSuspendedRef = useRef(mediaSuspended);
  mediaSuspendedRef.current = mediaSuspended;
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [qualityNotice, setQualityNotice] = useState<string | null>(null);
  const qualityNoticeTimer = useRef<number | null>(null);
  /** When DASH fails, switch to progressive fallback without remounting the page. */
  const [compatMode, setCompatMode] = useState(false);
  const [dashReloadToken, setDashReloadToken] = useState(0);
  const [shakaReady, setShakaReady] = useState(false);

  const effectiveStreamType: StreamType =
    compatMode || streamType !== "dash" ? "file" : "dash";
  const effectiveSrc =
    compatMode && progressiveFallbackSrc ? progressiveFallbackSrc : src;

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
  }, [videoRef, isSeekingRef]);

  useEffect(() => {
    return () => {
      if (bufferingShowTimer.current != null) {
        window.clearTimeout(bufferingShowTimer.current);
      }
    };
  }, []);

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
      if (!casting) {
        el.play().catch(() => undefined);
      }
    }
  }, [
    initialPosition,
    src,
    casting,
    effectiveStreamType,
    mediaSuspended,
    videoRef,
  ]);

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
  }, [progressiveFallbackSrc, showQualityNotice, videoRef, shakaPlayerRef]);

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
  }, [effectiveStreamType, shakaPlayerRef, videoRef]);

  /** A new source starts loading: clear errors, compat mode and the Shaka state. */
  const resetSource = useCallback(() => {
    setMediaError(null);
    if (bufferingShowTimer.current != null) {
      window.clearTimeout(bufferingShowTimer.current);
      bufferingShowTimer.current = null;
    }
    setBuffering(true);
    setCompatMode(false);
    setShakaReady(false);
  }, []);

  return {
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
  };
}
