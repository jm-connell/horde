import { useEffect, type RefObject } from "react";
import type { ViewMode } from "../videoPlayerTypes";

/**
 * Report the pillarbox inset (px) when the picture doesn't fill its box.
 */
export function useFrameInset(
  onFrameInsetChange: ((inset: number) => void) | undefined,
  videoRef: RefObject<HTMLVideoElement>,
  {
    isMini,
    isNativeFullscreen,
    mode,
    videoAspect,
  }: {
    isMini: boolean;
    isNativeFullscreen: boolean;
    mode: ViewMode;
    videoAspect: number | null;
  }
) {
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
  }, [
    onFrameInsetChange,
    videoRef,
    isMini,
    isNativeFullscreen,
    mode,
    videoAspect,
  ]);
}
