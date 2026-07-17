import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

/** Hover/focus/click popover tip — more reliable than native title on Windows. */
export default function HelpTip({
  text,
  placement = "top",
  children,
}: {
  text: string;
  /** Prefer "bottom" near the top of the viewport so the tip stays visible. */
  placement?: "top" | "bottom";
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{
    top: number;
    left: number;
    place: "top" | "bottom";
  } | null>(null);
  const tipId = useId();
  const anchorRef = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    if (!open || !anchorRef.current) {
      setCoords(null);
      return;
    }
    const rect = anchorRef.current.getBoundingClientRect();
    const gap = 8;
    let place = placement;
    // Prefer requested placement; flip if there isn't room.
    if (place === "top" && rect.top < 96) place = "bottom";
    if (place === "bottom" && window.innerHeight - rect.bottom < 96) {
      place = "top";
    }
    setCoords({
      top: place === "bottom" ? rect.bottom + gap : rect.top - gap,
      left: rect.left + rect.width / 2,
      place,
    });
  }, [open, placement, text]);

  // Close on outside click (click-to-open / touch).
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const el = anchorRef.current;
      if (el && !el.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const show = () => setOpen(true);
  const hide = () => setOpen(false);
  const showOnClick = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setOpen(true);
  };

  return (
    <span
      ref={anchorRef}
      className="relative inline-flex"
      onMouseEnter={show}
      onMouseLeave={hide}
    >
      {children ? (
        <span
          className="inline-flex"
          aria-describedby={open ? tipId : undefined}
          onFocus={show}
          onBlur={hide}
          onClick={showOnClick}
        >
          {children}
        </span>
      ) : (
        <button
          type="button"
          className="cursor-help text-gray-600 hover:text-gray-400"
          aria-label="More info"
          aria-describedby={open ? tipId : undefined}
          aria-expanded={open}
          onFocus={show}
          onBlur={hide}
          onClick={showOnClick}
        >
          (?)
        </button>
      )}
      {open &&
        coords &&
        createPortal(
          <span
            id={tipId}
            role="tooltip"
            className="ui-panel ui-panel-legible pointer-events-none fixed z-[200] w-64 -translate-x-1/2 rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-left text-xs leading-relaxed text-gray-300 shadow-xl ring-1 ring-ink-700"
            style={{
              top: coords.top,
              left: Math.min(
                Math.max(coords.left, 128),
                window.innerWidth - 128
              ),
              transform:
                coords.place === "bottom"
                  ? "translate(-50%, 0)"
                  : "translate(-50%, -100%)",
            }}
          >
            {text}
          </span>,
          document.body
        )}
    </span>
  );
}
