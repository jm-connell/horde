import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { UI_MENU_SURFACE } from "../uiMenu";

type Flip = "down" | "up";

const MENU_GAP_PX = 4;

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

/** Viewport-fixed coords so `.ui-menu` is not flattened by a parent `.ui-panel`. */
export function flipMenuFixedStyle(
  rect: Pick<DOMRect, "top" | "bottom" | "left" | "right" | "width">,
  flip: Flip,
  align: "left" | "right",
  viewport: { width: number; height: number },
  gap = MENU_GAP_PX
): CSSProperties {
  const style: CSSProperties = { minWidth: rect.width };
  if (flip === "down") style.top = rect.bottom + gap;
  else style.bottom = viewport.height - rect.top + gap;
  if (align === "left") style.left = rect.left;
  else style.right = viewport.width - rect.right;
  return style;
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
  const markerRef = useRef<HTMLSpanElement>(null);
  const [coords, setCoords] = useState<CSSProperties | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setCoords(null);
      return;
    }
    const anchor = markerRef.current?.parentElement;
    if (!anchor) return;

    const update = () => {
      const rect = anchor.getBoundingClientRect();
      setCoords(
        flipMenuFixedStyle(rect, flip, align, {
          width: window.innerWidth,
          height: window.innerHeight,
        })
      );
    };
    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [open, flip, align]);

  return (
    <>
      <span ref={markerRef} hidden />
      {open &&
        coords &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            data-horde="flip-menu"
            className={`fixed z-[80] overflow-hidden py-1 ${UI_MENU_SURFACE} ${className}`}
            style={coords}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {children}
          </div>,
          document.body
        )}
    </>
  );
}
