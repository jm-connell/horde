import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useSettings, type NavIndicator } from "../hooks/useSettings";
import { JELLY_MS, jellyKeyframes, type PillRect } from "./liquidJelly";
import {
  CORNERS,
  CORNER_ARM,
  DOT_EASE,
  DOT_SIZE,
  cornerKeyframes,
  cornerTransform,
  dotKeyframes,
  dotPoint,
  dotTransform,
  focusCorners,
  isStackedRow,
  type Point,
} from "./navIndicatorMotion";
import { EASE_FLUID } from "../motion";

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** The styles that move by transform (navIndicatorMotion). */
const TRANSFORM_STYLES = new Set<NavIndicator>(["dot", "focus"]);
/** Each Focus corner's two borders, in `CORNERS` order. */
const CORNER_CLASSES = [
  "border-l-2 border-t-2 rounded-tl-[3px]",
  "border-r-2 border-t-2 rounded-tr-[3px]",
  "border-l-2 border-b-2 rounded-bl-[3px]",
  "border-r-2 border-b-2 rounded-br-[3px]",
];
const TRANSFORM_MS = 300;

/** Where an element is drawn right now, mid-animation included. */
function currentMatrix(el: Element): DOMMatrixReadOnly {
  const t = getComputedStyle(el).transform;
  return t && t !== "none" ? new DOMMatrixReadOnly(t) : new DOMMatrixReadOnly();
}

/**
 * Sliding nav indicator (liquid / underline / fade / dot / focus) that
 * follows the child marked with data-liquid-active="true".
 *
 * Liquid mode: the pill pours into the clicked item like liquid (see
 * `jellyKeyframes`); a click mid-move carries on from where it is. Dot and
 * Focus do the same with transforms (`navIndicatorMotion`).
 */
export default function LiquidNav({
  children,
  className = "",
  pillClassName = "bg-accent/15",
  dependency,
  role,
  "aria-label": ariaLabel,
}: {
  children: ReactNode;
  className?: string;
  pillClassName?: string;
  dependency?: string | number | boolean;
  /** e.g. "tablist" when the children are role="tab" buttons. */
  role?: string;
  "aria-label"?: string;
}) {
  const [settings] = useSettings();
  const style: NavIndicator = settings.navIndicator;
  const enabled = style !== "none";
  const containerRef = useRef<HTMLDivElement>(null);
  const [pill, setPill] = useState<PillRect | null>(null);
  /** The active item fills the nav's width: a stacked menu (Dot's bullet). */
  const [stacked, setStacked] = useState(false);
  const [ready, setReady] = useState(false);
  const prevPill = useRef<PillRect | null>(null);
  const pillRef = useRef<HTMLSpanElement>(null);
  const jelly = useRef<Animation | null>(null);
  const cornerRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const moves = useRef<Animation[]>([]);
  const transformStyle = TRANSFORM_STYLES.has(style);

  const measure = useCallback(() => {
    const root = containerRef.current;
    if (!root) return;
    const active = root.querySelector<HTMLElement>(
      '[data-liquid-active="true"]'
    );
    if (!active) {
      setPill(null);
      return;
    }
    const parent = root.getBoundingClientRect();
    const rect = active.getBoundingClientRect();
    const next: PillRect = {
      left: rect.left - parent.left + root.scrollLeft,
      top: rect.top - parent.top + root.scrollTop,
      width: rect.width,
      height: rect.height,
    };
    const nextStacked = isStackedRow(next, root.clientWidth);

    const prev = prevPill.current;
    const moved =
      prev &&
      (Math.abs(prev.left - next.left) > 2 ||
        Math.abs(prev.width - next.width) > 2 ||
        Math.abs(prev.top - next.top) > 2);

    const el = pillRef.current;
    if (
      moved &&
      prev &&
      style === "liquid" &&
      el &&
      typeof el.animate === "function" &&
      !prefersReducedMotion()
    ) {
      // Start from where the pill is on screen, even mid-animation.
      const from: PillRect = {
        left: el.offsetLeft,
        top: el.offsetTop,
        width: el.offsetWidth,
        height: el.offsetHeight,
      };
      jelly.current?.cancel();
      jelly.current = el.animate(jellyKeyframes(from, next), {
        duration: JELLY_MS,
      });
    }

    if (
      moved &&
      prev &&
      TRANSFORM_STYLES.has(style) &&
      typeof root.animate === "function" &&
      !prefersReducedMotion()
    ) {
      // Read every piece where it is drawn now, then restart from there.
      const pieces =
        style === "focus"
          ? cornerRefs.current.filter((c): c is HTMLSpanElement => !!c)
          : el
            ? [el]
            : [];
      const from = pieces.map(currentMatrix);
      for (const a of moves.current) a.cancel();
      const timing = { duration: TRANSFORM_MS, easing: EASE_FLUID };
      moves.current = pieces.map((piece, i) => {
        const at: Point = { x: from[i].m41, y: from[i].m42 };
        if (style === "dot") {
          return piece.animate(dotKeyframes(at, dotPoint(next, nextStacked)), {
            ...timing,
            easing: DOT_EASE,
          });
        }
        return piece.animate(
          cornerKeyframes(at, focusCorners(next)[i], CORNERS[i]),
          timing
        );
      });
    }

    prevPill.current = next;
    setPill(next);
    setStacked(nextStacked);
    // Liquid and the transform styles move by animation, not a CSS transition.
    setReady(style !== "liquid" && !TRANSFORM_STYLES.has(style));
  }, [style]);

  useLayoutEffect(() => {
    if (!enabled) return;
    measure();
  }, [measure, dependency, children, enabled, style]);

  useEffect(() => {
    if (!enabled) return;
    const root = containerRef.current;
    if (!root) return;
    const onResize = () => measure();
    window.addEventListener("resize", onResize);
    const ro =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(measure)
        : null;
    ro?.observe(root);
    return () => {
      window.removeEventListener("resize", onResize);
      ro?.disconnect();
      jelly.current?.cancel();
      for (const a of moves.current) a.cancel();
    };
  }, [measure, enabled]);

  if (!enabled) {
    return (
      <div className={className} role={role} aria-label={ariaLabel}>
        {children}
      </div>
    );
  }

  const isUnderline = style === "underline";
  const isFade = style === "fade";

  const transition = !ready
    ? "none"
    : isFade
      ? "left 300ms ease, top 300ms ease, width 300ms ease, height 300ms ease, opacity 240ms ease"
      : `left 280ms ${EASE_FLUID}, top 280ms ${EASE_FLUID}, width 280ms ${EASE_FLUID}`;

  return (
    <div
      ref={containerRef}
      className={`relative ${className}`}
      role={role}
      aria-label={ariaLabel}
    >
      {pill && style === "dot" && (
        <span
          ref={pillRef}
          aria-hidden
          className="pointer-events-none absolute left-0 top-0 z-0 rounded-full bg-accent"
          style={{
            width: DOT_SIZE,
            height: DOT_SIZE,
            transform: dotTransform(dotPoint(pill, stacked)),
          }}
        />
      )}
      {pill &&
        style === "focus" &&
        focusCorners(pill).map((corner, i) => (
          <span
            key={i}
            ref={(node) => {
              cornerRefs.current[i] = node;
            }}
            aria-hidden
            className={`pointer-events-none absolute left-0 top-0 z-0 border-accent ${CORNER_CLASSES[i]}`}
            style={{
              width: CORNER_ARM,
              height: CORNER_ARM,
              transform: cornerTransform(corner),
            }}
          />
        ))}
      {pill && !transformStyle && (
        <span
          ref={pillRef}
          aria-hidden
          className={`pointer-events-none absolute z-0 ${
            isUnderline
              ? "rounded-full bg-accent"
              : isFade
                ? `rounded-lg ${pillClassName} opacity-90`
                : `rounded-lg ${pillClassName}`
          }`}
          style={
            isUnderline
              ? {
                  left: pill.left + 8,
                  top: pill.top + pill.height - 4,
                  width: Math.max(16, pill.width - 16),
                  height: 3,
                  transition,
                }
              : {
                  left: pill.left,
                  top: pill.top,
                  width: pill.width,
                  height: pill.height,
                  transition,
                  borderRadius: "0.5rem",
                }
          }
        />
      )}
      {children}
    </div>
  );
}
