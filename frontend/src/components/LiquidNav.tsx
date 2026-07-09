import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useSettings, type NavIndicator } from "../hooks/useSettings";

interface PillRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Sliding nav indicator (liquid / underline / fade) that follows the child
 * marked with data-liquid-active="true".
 *
 * Liquid mode: the highlight stretches to cover old→new, then snaps into the
 * new item so it feels like the destination is sucking the pill across.
 */
export default function LiquidNav({
  children,
  className = "",
  pillClassName = "bg-accent/15",
  dependency,
}: {
  children: ReactNode;
  className?: string;
  pillClassName?: string;
  dependency?: string | number | boolean;
}) {
  const [settings] = useSettings();
  const style: NavIndicator = settings.navIndicator;
  const enabled = style !== "none";
  const containerRef = useRef<HTMLDivElement>(null);
  const [pill, setPill] = useState<PillRect | null>(null);
  const [ready, setReady] = useState(false);
  const [traveling, setTraveling] = useState(false);
  const prevPill = useRef<PillRect | null>(null);
  const travelTimer = useRef<number | null>(null);

  const measure = useCallback(() => {
    const root = containerRef.current;
    if (!root) return;
    const active = root.querySelector<HTMLElement>('[data-liquid-active="true"]');
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

    if (moved && prev && style === "liquid") {
      // Phase 1: stretch to bridge old and new (no transition).
      const bridge: PillRect = {
        left: Math.min(prev.left, next.left),
        top: Math.min(prev.top, next.top),
        width:
          Math.max(prev.left + prev.width, next.left + next.width) -
          Math.min(prev.left, next.left),
        height: Math.max(prev.height, next.height),
      };
      setReady(false);
      setTraveling(true);
      setPill(bridge);
      prevPill.current = next;

      if (travelTimer.current) window.clearTimeout(travelTimer.current);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setReady(true);
          setPill(next);
          travelTimer.current = window.setTimeout(() => {
            setTraveling(false);
            travelTimer.current = null;
          }, 320);
        });
      });
      return;
    }

    if (moved) {
      setTraveling(true);
      if (travelTimer.current) window.clearTimeout(travelTimer.current);
      travelTimer.current = window.setTimeout(() => {
        setTraveling(false);
        travelTimer.current = null;
      }, 300);
    }

    prevPill.current = next;
    setPill(next);
    setReady(true);
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
      typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    ro?.observe(root);
    return () => {
      window.removeEventListener("resize", onResize);
      ro?.disconnect();
      if (travelTimer.current) window.clearTimeout(travelTimer.current);
    };
  }, [measure, enabled]);

  if (!enabled) {
    return <div className={className}>{children}</div>;
  }

  const isUnderline = style === "underline";
  const isFade = style === "fade";
  const isLiquid = style === "liquid";

  const transition = !ready
    ? "none"
    : isLiquid
      ? "left 280ms cubic-bezier(0.22, 1, 0.36, 1), top 280ms cubic-bezier(0.22, 1, 0.36, 1), width 280ms cubic-bezier(0.22, 1, 0.36, 1), height 280ms cubic-bezier(0.22, 1, 0.36, 1), border-radius 280ms cubic-bezier(0.22, 1, 0.36, 1)"
      : isFade
        ? "left 300ms ease, top 300ms ease, width 300ms ease, height 300ms ease, opacity 240ms ease"
        : "left 280ms cubic-bezier(0.22, 1, 0.36, 1), top 280ms cubic-bezier(0.22, 1, 0.36, 1), width 280ms cubic-bezier(0.22, 1, 0.36, 1)";

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      {pill && (
        <span
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
                  borderRadius:
                    isLiquid && traveling ? "0.85rem" : "0.5rem",
                }
          }
        />
      )}
      {children}
    </div>
  );
}
