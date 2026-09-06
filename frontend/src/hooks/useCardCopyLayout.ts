import { useCallback, useLayoutEffect, useState } from "react";

export const TITLE_LINE_CAP = 8;
export const TITLE_LH_REM = 1.25;
export const META_LH_REM = 1;
export const COPY_GAP_REM = 0.25;

export function remPx(): number {
  if (typeof document === "undefined") return 16;
  return parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
}

export function detailsInnerHeight(el: HTMLElement): number {
  const style = getComputedStyle(el);
  const pad =
    (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
  return el.getBoundingClientRect().height - pad;
}

export function detailsContentWidth(el: HTMLElement): number {
  const style = getComputedStyle(el);
  const pad =
    (parseFloat(style.paddingLeft) || 0) +
    (parseFloat(style.paddingRight) || 0);
  return el.getBoundingClientRect().width - pad;
}

export function lineCountFromBox(
  height: number,
  lineHeight: number,
  cap = TITLE_LINE_CAP
): number {
  if (lineHeight <= 0) return 1;
  return Math.min(cap, Math.max(1, Math.round(height / lineHeight)));
}

export function readSizerLineCount(el: HTMLElement): number {
  const style = getComputedStyle(el);
  let lineHeight = parseFloat(style.lineHeight);
  if (!Number.isFinite(lineHeight) || lineHeight <= 0) {
    const fontSize = parseFloat(style.fontSize);
    lineHeight = (Number.isFinite(fontSize) ? fontSize : 14) * TITLE_LH_REM;
  }
  return lineCountFromBox(el.getBoundingClientRect().height, lineHeight);
}

export function combinedMetaOverflows(
  contentWidth: number,
  availableWidth: number
): boolean {
  return availableWidth > 0 && contentWidth > availableWidth - 0.5;
}

export function readCombinedMetaOverflows(
  sizer: HTMLElement,
  availableWidth: number
): boolean {
  return combinedMetaOverflows(
    sizer.getBoundingClientRect().width,
    availableWidth
  );
}

/**
 * Stack vs combine using leftover as if the footer were still combined,
 * so choosing stack cannot flip the boolean back.
 *
 * Width overflow of a hypothetical nowrap combined footer also stacks,
 * even in a compact cell (title may clamp to make room).
 */
export function shouldStackMeta({
  titleNeeded,
  detailsInner,
  rem,
  hasSecondary,
  combinedOverflows = false,
}: {
  titleNeeded: number;
  detailsInner: number;
  rem: number;
  hasSecondary: boolean;
  combinedOverflows?: boolean;
}): boolean {
  if (!hasSecondary) return false;
  if (titleNeeded <= 1) return true;
  if (combinedOverflows) return true;
  if (detailsInner <= 0) return false;

  const titleLh = TITLE_LH_REM * rem;
  const metaLh = META_LH_REM * rem;
  const gap = COPY_GAP_REM * rem;
  const combinedUsed = titleNeeded * titleLh + gap + metaLh;
  return detailsInner - combinedUsed + 1 >= metaLh + gap;
}

export function titleLinesShown({
  titleNeeded,
  detailsInner,
  stacked,
  rem,
}: {
  titleNeeded: number;
  detailsInner: number;
  stacked: boolean;
  rem: number;
}): number {
  if (detailsInner <= 0) return Math.min(titleNeeded, 2);

  const titleLh = TITLE_LH_REM * rem;
  const metaLh = META_LH_REM * rem;
  const gap = COPY_GAP_REM * rem;
  const footer = stacked ? 2 * metaLh + gap : metaLh;
  const titleBox = detailsInner - gap - footer;
  const fit = Math.max(1, Math.floor((titleBox + 0.5) / titleLh));
  return Math.min(titleNeeded, fit);
}

function useNodeRef(): {
  node: HTMLElement | null;
  ref: (node: HTMLElement | null) => void;
} {
  const [node, setNode] = useState<HTMLElement | null>(null);
  const ref = useCallback((next: HTMLElement | null) => {
    setNode(next);
  }, []);
  return { node, ref };
}

export function useCardCopyLayout(
  title: string,
  hasSecondary: boolean,
  enabled = true
): {
  detailsRef: (node: HTMLElement | null) => void;
  sizerRef: (node: HTMLElement | null) => void;
  combinedSizerRef: (node: HTMLElement | null) => void;
  stacked: boolean;
  titleLines: number;
  titleNeeded: number;
} {
  const details = useNodeRef();
  const sizer = useNodeRef();
  const combined = useNodeRef();
  const [titleNeeded, setTitleNeeded] = useState(2);
  const [detailsInner, setDetailsInner] = useState(0);
  const [combinedOverflows, setCombinedOverflows] = useState(false);

  useLayoutEffect(() => {
    if (!enabled) {
      setTitleNeeded(2);
      setDetailsInner(0);
      setCombinedOverflows(false);
      return;
    }
    const sizerEl = sizer.node;
    const detailsEl = details.node;
    const combinedEl = combined.node;
    if (!sizerEl && !detailsEl && !combinedEl) return;

    const measure = () => {
      if (sizerEl) {
        const next = readSizerLineCount(sizerEl);
        setTitleNeeded((prev) => (prev === next ? prev : next));
      }
      if (detailsEl) {
        const next = detailsInnerHeight(detailsEl);
        setDetailsInner((prev) => (Math.abs(prev - next) < 0.5 ? prev : next));
      }
      if (combinedEl && detailsEl) {
        const next = readCombinedMetaOverflows(
          combinedEl,
          detailsContentWidth(detailsEl)
        );
        setCombinedOverflows((prev) => (prev === next ? prev : next));
      } else {
        setCombinedOverflows((prev) => (prev ? false : prev));
      }
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (sizerEl) ro.observe(sizerEl);
    if (detailsEl) ro.observe(detailsEl);
    if (combinedEl) ro.observe(combinedEl);
    void document.fonts?.ready.then(() => {
      if (sizerEl?.isConnected || detailsEl?.isConnected || combinedEl?.isConnected) {
        measure();
      }
    });
    return () => ro.disconnect();
  }, [enabled, title, sizer.node, details.node, combined.node]);

  const rem = remPx();
  const stacked = shouldStackMeta({
    titleNeeded,
    detailsInner,
    rem,
    hasSecondary,
    combinedOverflows,
  });
  const titleLines = titleLinesShown({
    titleNeeded,
    detailsInner,
    stacked,
    rem,
  });

  return {
    detailsRef: details.ref,
    sizerRef: sizer.ref,
    combinedSizerRef: combined.ref,
    stacked,
    titleLines,
    titleNeeded,
  };
}
