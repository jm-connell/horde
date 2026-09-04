import { useLayoutEffect, useRef } from "react";

export const CLIP_DURATION_MS = 400;
export const CLIP_EASING = "cubic-bezier(0.22, 1, 0.36, 1)";

export function remPx(rem: number): number {
  const rootPx =
    parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  return rem * rootPx;
}

/**
 * Animate an element's height between a collapsed max and its content size.
 * Expanded resting state is `height: auto` so the box is only as tall as
 * its content (no extra whitespace).
 */
export function useAnimatedClipHeight(
  clipRef: { readonly current: HTMLElement | null },
  expanded: boolean,
  collapsedRem: number,
  contentKey?: string | number | null,
  onSettled?: (expanded: boolean) => void
) {
  const prevExpandedRef = useRef<boolean | null>(null);
  const onSettledRef = useRef(onSettled);
  onSettledRef.current = onSettled;

  useLayoutEffect(() => {
    const clip = clipRef.current;
    if (!clip) {
      prevExpandedRef.current = null;
      return;
    }

    const collapsedMax = remPx(collapsedRem);
    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches;
    const target = expanded
      ? clip.scrollHeight
      : Math.min(clip.scrollHeight, collapsedMax);

    const applyResting = () => {
      clip.style.transition = "none";
      if (expanded) {
        clip.style.height = "auto";
        clip.style.overflow = "visible";
      } else {
        clip.style.height = `${target}px`;
        clip.style.overflow = "auto";
      }
    };

    const prev = prevExpandedRef.current;
    prevExpandedRef.current = expanded;

    // First layout, or a content/layout change that isn't an expand toggle.
    if (prev === null || prev === expanded) {
      applyResting();
      return;
    }

    const notifySettled = () => onSettledRef.current?.(expanded);

    const from = clip.getBoundingClientRect().height;
    if (reduceMotion || Math.abs(from - target) < 1) {
      applyResting();
      notifySettled();
      return;
    }

    clip.style.overflow = "hidden";
    clip.style.transition = "none";
    clip.style.height = `${from}px`;
    void clip.offsetHeight;
    clip.style.transition = `height ${CLIP_DURATION_MS}ms ${CLIP_EASING}`;
    clip.style.height = `${target}px`;

    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      clip.style.transition = "";
      if (expanded) {
        clip.style.height = "auto";
        clip.style.overflow = "visible";
      } else {
        clip.style.overflow = "auto";
      }
      notifySettled();
    };
    const onEnd = (event: TransitionEvent) => {
      if (event.target !== clip || event.propertyName !== "height") return;
      settle();
    };
    clip.addEventListener("transitionend", onEnd);
    const fallback = window.setTimeout(settle, CLIP_DURATION_MS + 50);
    return () => {
      clip.removeEventListener("transitionend", onEnd);
      window.clearTimeout(fallback);
    };
  }, [clipRef, expanded, collapsedRem, contentKey]);
}
