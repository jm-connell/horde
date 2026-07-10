import {
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";

type Flip = "down" | "up";

/**
 * Prefer opening up unless there is clearly enough space below.
 * Attach `anchorRef` to the relative menu wrapper so measurement works.
 */
export function useFlipMenu(
  open: boolean,
  estimatedHeight = 280
): { flip: Flip; anchorRef: RefObject<HTMLDivElement> } {
  const [flip, setFlip] = useState<Flip>("up");
  const anchorRef = useRef<HTMLDivElement>(null!);

  useLayoutEffect(() => {
    if (!open) return;
    const el = anchorRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    // Open down only when there is plenty of room underneath.
    if (spaceBelow >= estimatedHeight + 24) {
      setFlip("down");
    } else if (spaceAbove > spaceBelow) {
      setFlip("up");
    } else {
      setFlip(spaceBelow >= spaceAbove ? "down" : "up");
    }
  }, [open, estimatedHeight]);

  return { flip, anchorRef };
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
  const pos = flip === "down" ? "top-full mt-1" : "bottom-full mb-1";
  const side = align === "left" ? "left-0" : "right-0";
  return (
    <div
      className={`ui-panel ui-panel-legible absolute z-50 ${pos} ${side} overflow-hidden rounded-lg border border-ink-700 bg-ink-800 py-1 shadow-2xl ring-1 ring-ink-600 ${className}`}
    >
      {children}
    </div>
  );
}
