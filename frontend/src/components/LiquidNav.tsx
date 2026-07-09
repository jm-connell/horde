import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useSettings } from "../hooks/useSettings";

interface PillRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Sliding "liquid" highlight that morphs between the active child marked with
 * data-liquid-active="true". Works for top nav and settings tabs.
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
  /** Re-measure when this changes (e.g. route or tab id). */
  dependency?: string | number | boolean;
}) {
  const [settings] = useSettings();
  const enabled = settings.liquidNav;
  const containerRef = useRef<HTMLDivElement>(null);
  const [pill, setPill] = useState<PillRect | null>(null);
  const [ready, setReady] = useState(false);

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
    setPill({
      left: rect.left - parent.left + root.scrollLeft,
      top: rect.top - parent.top + root.scrollTop,
      width: rect.width,
      height: rect.height,
    });
    setReady(true);
  }, []);

  useLayoutEffect(() => {
    if (!enabled) return;
    measure();
  }, [measure, dependency, children, enabled]);

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
    };
  }, [measure, enabled]);

  if (!enabled) {
    return <div className={className}>{children}</div>;
  }

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      {pill && (
        <span
          aria-hidden
          className={`pointer-events-none absolute z-0 rounded-lg ${pillClassName}`}
          style={{
            left: pill.left,
            top: pill.top,
            width: pill.width,
            height: pill.height,
            transition: ready
              ? "left 420ms cubic-bezier(0.22, 1, 0.36, 1), top 420ms cubic-bezier(0.22, 1, 0.36, 1), width 420ms cubic-bezier(0.22, 1, 0.36, 1), height 420ms cubic-bezier(0.22, 1, 0.36, 1)"
              : "none",
          }}
        />
      )}
      {children}
    </div>
  );
}
