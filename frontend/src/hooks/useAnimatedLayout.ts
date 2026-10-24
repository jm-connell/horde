import { useLayoutEffect, useRef } from "react";
import { CLIP_DURATION_MS, CLIP_EASING } from "./useAnimatedClipHeight";

/**
 * Glide an element from where it was to where it now is when `layoutKey`
 * changes (FLIP: measure, invert with a transform, play back to none).
 * Use for any element that jumps position or size because of a state change,
 * such as a panel that switches sides. Changes with the same key (window
 * resize, content updates) apply at once.
 */
export function useAnimatedLayout(
  ref: { readonly current: HTMLElement | null },
  layoutKey: string | number | boolean | null
) {
  const prevRect = useRef<DOMRect | null>(null);
  const prevKey = useRef(layoutKey);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) {
      prevRect.current = null;
      return;
    }
    const from = prevRect.current;
    const keyChanged = prevKey.current !== layoutKey;
    prevKey.current = layoutKey;
    const to = el.getBoundingClientRect();
    prevRect.current = to;
    if (
      !from ||
      !keyChanged ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }
    const dx = from.left - to.left;
    const dy = from.top - to.top;
    const sx = to.width ? from.width / to.width : 1;
    const sy = to.height ? from.height / to.height : 1;
    if (
      Math.abs(dx) < 1 &&
      Math.abs(dy) < 1 &&
      Math.abs(sx - 1) < 0.01 &&
      Math.abs(sy - 1) < 0.01
    ) {
      return;
    }
    el.animate(
      [
        {
          transformOrigin: "top left",
          transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`,
        },
        { transformOrigin: "top left", transform: "none" },
      ],
      { duration: CLIP_DURATION_MS, easing: CLIP_EASING }
    );
  });
}
