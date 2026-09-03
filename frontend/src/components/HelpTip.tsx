import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
  type Ref,
} from "react";
import { createPortal } from "react-dom";

const TIP_WIDTH = 288; // tailwind w-72
const VIEW_MARGIN = 8;
const CURSOR_GAP_X = 12;
const CURSOR_GAP_Y = 14;

/** Hover/focus/click popover tip — more reliable than native title on Windows. */
export default function HelpTip({
  text,
  placement = "top",
  children,
  className,
  as: Tag = "span",
}: {
  text: string;
  /** Prefer "bottom" near the top of the viewport so the tip stays visible. */
  placement?: "top" | "bottom";
  children?: ReactNode;
  className?: string;
  /** Use "div" when wrapping a dl row (dt/dd must not sit inside a span). */
  as?: "span" | "div";
}) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{
    top: number;
    left: number;
    place: "top" | "bottom";
  } | null>(null);
  const tipId = useId();
  const anchorRef = useRef<HTMLElement>(null);
  const pointerOpen = useRef(false);
  const rafRef = useRef<number | null>(null);
  const pendingPtr = useRef<{ x: number; y: number } | null>(null);
  const placementRef = useRef(placement);
  placementRef.current = placement;

  const placeAt = (x: number, y: number) => {
    const preferred = placementRef.current;
    let place = preferred;
    if (place === "top" && y < 96) place = "bottom";
    if (place === "bottom" && window.innerHeight - y < 120) place = "top";

    let left = x + CURSOR_GAP_X;
    if (left + TIP_WIDTH > window.innerWidth - VIEW_MARGIN) {
      left = x - CURSOR_GAP_X - TIP_WIDTH;
    }
    left = Math.min(
      Math.max(left, VIEW_MARGIN),
      window.innerWidth - TIP_WIDTH - VIEW_MARGIN
    );

    const top = place === "bottom" ? y + CURSOR_GAP_Y : y - CURSOR_GAP_Y;
    setCoords((prev) => {
      if (prev && prev.top === top && prev.left === left && prev.place === place) {
        return prev;
      }
      return { top, left, place };
    });
  };

  const placeAtAnchor = () => {
    const el = anchorRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = rect.left + Math.min(Math.max(rect.width / 2, 8), 24);
    const y = placementRef.current === "bottom" ? rect.bottom : rect.top;
    placeAt(x, y);
  };

  // Keyboard / no-pointer open: sit next to the control, not the row center.
  useLayoutEffect(() => {
    if (!open || pointerOpen.current) return;
    placeAtAnchor();
  }, [open, text]);

  useEffect(() => {
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  // Close on outside click (click-to-open / touch).
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const el = anchorRef.current;
      if (el && !el.contains(e.target as Node)) {
        pointerOpen.current = false;
        setOpen(false);
        setCoords(null);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const showFromPointer = (e: MouseEvent) => {
    pointerOpen.current = true;
    placeAt(e.clientX, e.clientY);
    setOpen(true);
  };

  const hide = () => {
    pointerOpen.current = false;
    pendingPtr.current = null;
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    setOpen(false);
    setCoords(null);
  };

  const followPointer = (e: MouseEvent) => {
    if (!pointerOpen.current) return;
    pendingPtr.current = { x: e.clientX, y: e.clientY };
    if (rafRef.current != null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const p = pendingPtr.current;
      if (p) placeAt(p.x, p.y);
    });
  };

  const showOnClick = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    showFromPointer(e);
  };

  const tooltip =
    open && coords
      ? createPortal(
          <span
            id={tipId}
            role="tooltip"
            className="ui-panel ui-panel-legible pointer-events-none fixed z-[200] w-72 max-w-[calc(100vw-1.5rem)] rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-left text-xs leading-relaxed text-gray-300 shadow-xl ring-1 ring-ink-700"
            style={{
              top: coords.top,
              left: coords.left,
              transform:
                coords.place === "bottom" ? undefined : "translateY(-100%)",
            }}
          >
            {text}
          </span>,
          document.body
        )
      : null;

  return (
    <Tag
      ref={anchorRef as Ref<HTMLDivElement>}
      className={`relative ${className ?? "inline-flex"}`}
      aria-describedby={children && open ? tipId : undefined}
      onMouseEnter={showFromPointer}
      onMouseMove={followPointer}
      onMouseLeave={hide}
      onClick={children ? showOnClick : undefined}
    >
      {children ? (
        children
      ) : (
        <button
          type="button"
          className="cursor-help text-gray-600 hover:text-gray-400"
          aria-label="More info"
          aria-describedby={open ? tipId : undefined}
          aria-expanded={open}
          onFocus={() => {
            pointerOpen.current = false;
            setOpen(true);
          }}
          onBlur={hide}
          onClick={showOnClick}
        >
          (?)
        </button>
      )}
      {tooltip}
    </Tag>
  );
}
