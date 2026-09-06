import { useLayoutEffect, useRef } from "react";

export const CLIP_DURATION_MS = 400;
export const CLIP_EASING = "cubic-bezier(0.22, 1, 0.36, 1)";

export function remPx(rem: number): number {
  const rootPx =
    parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  return rem * rootPx;
}

/** Content height ignoring any current pixel clip (which inflates scrollHeight). */
function measureContentHeight(clip: HTMLElement): number {
  const prevHeight = clip.style.height;
  const prevOverflow = clip.style.overflow;
  const prevTransition = clip.style.transition;
  clip.style.transition = "none";
  clip.style.height = "auto";
  clip.style.overflow = "hidden";
  const contentHeight = clip.scrollHeight;
  clip.style.height = prevHeight;
  clip.style.overflow = prevOverflow;
  clip.style.transition = prevTransition;
  return contentHeight;
}

/**
 * Animate an element's height between a collapsed max and its content size.
 * Expanded resting state is `height: auto` so the box is only as tall as
 * its content (no extra whitespace). Content changes (e.g. regenerated
 * chapters) remeasure and resize even when the expand state is unchanged.
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
    const contentHeight = measureContentHeight(clip);
    const target = expanded
      ? contentHeight
      : Math.min(contentHeight, collapsedMax);

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
    const expandedChanged = prev !== null && prev !== expanded;

    const from = clip.getBoundingClientRect().height;
    if (prev === null || reduceMotion || Math.abs(from - target) < 1) {
      applyResting();
      if (expandedChanged) onSettledRef.current?.(expanded);
      return;
    }

    const notifySettled = () => {
      if (expandedChanged) onSettledRef.current?.(expanded);
    };

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
