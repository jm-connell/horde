import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

type Flip = "down" | "up";

/** Prefer opening down; flip up when there isn't enough space below. */
export function useFlipMenu(open: boolean, estimatedHeight = 280): Flip {
  const [flip, setFlip] = useState<Flip>("down");
  const anchorRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open || !anchorRef.current) return;
    const rect = anchorRef.current.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    if (spaceBelow < estimatedHeight && spaceAbove > spaceBelow) {
      setFlip("up");
    } else {
      setFlip("down");
    }
  }, [open, estimatedHeight]);

  return flip;
}

export function FlipMenuPanel({
  open,
  flip,
  align = "left",
  className = "",
  children,
}: {
  open: boolean;
  flip: Flip;
  align?: "left" | "right";
  className?: string;
  children: ReactNode;
}) {
  if (!open) return null;
  const pos =
    flip === "down"
      ? "top-full mt-1"
      : "bottom-full mb-1";
  const side = align === "left" ? "left-0" : "right-0";
  return (
    <div
      className={`ui-panel absolute z-50 ${pos} ${side} overflow-hidden rounded-lg bg-ink-800 py-1 shadow-2xl ring-1 ring-ink-600 ${className}`}
      style={
        {
          // Inherit translucent panel vars when enabled via .ui-panel
        } as CSSProperties
      }
    >
      {children}
    </div>
  );
}

export function useMenuAnchor() {
  return useRef<HTMLDivElement>(null);
}
