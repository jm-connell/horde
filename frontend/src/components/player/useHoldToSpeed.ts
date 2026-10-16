import { useCallback, useEffect, useRef, type RefObject } from "react";
import { HOLD_DELAY_MS } from "./constants";

interface Options {
  videoRef: RefObject<HTMLVideoElement>;
  isMini: boolean;
  isMobile: boolean;
  rate: number;
  setRate: (rate: number) => void;
  /** Speed used while the pointer is held down on the video. */
  holdPlaybackRate: number;
  /** Set after a hold or drag so the click that ends it doesn't toggle play. */
  suppressClick: { current: boolean };
  togglePlay: () => void;
}

/**
 * Pointer handling on the video itself: press and hold to play at the hold
 * speed (restoring the previous rate on release), tap to toggle on phones and
 * click to toggle elsewhere.
 */
export function useHoldToSpeed({
  videoRef,
  isMini,
  isMobile,
  rate,
  setRate,
  holdPlaybackRate,
  suppressClick,
  togglePlay,
}: Options) {
  const heldRate = useRef<number | null>(null);
  const holdTimer = useRef<number | null>(null);
  const holdActive = useRef(false);
  const wasPlayingBeforeHold = useRef(false);
  const pointerDownOnVideo = useRef(false);
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
  }, [videoRef, setRate, suppressClick]);

  const activateHold = useCallback(() => {
    const v = videoRef.current;
    if (!v || heldRate.current !== null) return;
    holdActive.current = true;
    wasPlayingBeforeHold.current = !v.paused;
    heldRate.current = rate;
    setRate(holdPlaybackRate);
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
  }, [rate, endHold, holdPlaybackRate, videoRef, setRate]);

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
    [isMini, endHold, isMobile, togglePlay, suppressClick]
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
    [isMobile, togglePlay, suppressClick]
  );

  return {
    endHold,
    onVideoPointerDown,
    onVideoPointerUp,
    onVideoPointerCancel,
    onVideoClick,
  };
}
