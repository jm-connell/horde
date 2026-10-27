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

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Sliding nav indicator (liquid / underline / fade) that follows the child
 * marked with data-liquid-active="true".
 *
 * Liquid mode: the pill pours into the clicked item like liquid (see
 * `jellyKeyframes`); a click mid-move carries on from where it is.
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
  const [ready, setReady] = useState(false);
  const prevPill = useRef<PillRect | null>(null);
  const pillRef = useRef<HTMLSpanElement>(null);
  const jelly = useRef<Animation | null>(null);

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

    prevPill.current = next;
    setPill(next);
    // Liquid moves are the jelly animation, not a CSS transition.
    setReady(style !== "liquid");
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
      : "left 280ms cubic-bezier(0.22, 1, 0.36, 1), top 280ms cubic-bezier(0.22, 1, 0.36, 1), width 280ms cubic-bezier(0.22, 1, 0.36, 1)";

  return (
    <div
      ref={containerRef}
      className={`relative ${className}`}
      role={role}
      aria-label={ariaLabel}
    >
      {pill && (
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
