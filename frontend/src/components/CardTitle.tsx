import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
} from "react";
import { createPortal } from "react-dom";

const TIP_WIDTH = 288;
const VIEW_MARGIN = 8;
const CURSOR_GAP_X = 12;
const CURSOR_GAP_Y = 14;
const SHOW_DELAY_MS = 200;

function lineClampOverflows(el: HTMLElement): boolean {
  if (el.scrollWidth > el.clientWidth + 1) return true;
  if (el.scrollHeight > el.clientHeight + 1) return true;

  const width = el.getBoundingClientRect().width;
  if (width <= 0) return false;

  const cs = getComputedStyle(el);
  const clone = el.cloneNode(true) as HTMLElement;
  clone.removeAttribute("id");
  clone.setAttribute("aria-hidden", "true");
  clone.style.position = "fixed";
  clone.style.left = "0";
  clone.style.top = "0";
  clone.style.visibility = "hidden";
  clone.style.pointerEvents = "none";
  clone.style.height = "auto";
  clone.style.maxHeight = "none";
  clone.style.minHeight = "0";
  clone.style.width = `${width}px`;
  clone.style.display = "block";
  clone.style.overflow = "visible";
  clone.style.webkitLineClamp = "unset";
  clone.style.webkitBoxOrient = "unset";
  clone.style.font = cs.font;
  clone.style.letterSpacing = cs.letterSpacing;
  clone.style.wordBreak = cs.wordBreak;
  clone.style.overflowWrap = cs.overflowWrap;
  clone.style.whiteSpace = cs.whiteSpace;
  clone.style.lineHeight = cs.lineHeight;
  document.body.appendChild(clone);
  const needed = clone.getBoundingClientRect().height;
  const shown = el.getBoundingClientRect().height;
  clone.remove();
  return needed > shown + 1;
}

/** Line-clamped card title with a hover tooltip of the full name when truncated. */
export default function CardTitle({
  text,
  truncated,
  className,
  style,
}: {
  text: string;
  /** When known from layout measurement; omit to detect on hover. */
  truncated?: boolean;
  className?: string;
  style?: CSSProperties;
}) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{
    top: number;
    left: number;
    place: "top" | "bottom";
  } | null>(null);
  const tipId = useId();
  const delayRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const pendingPtr = useRef<{ x: number; y: number } | null>(null);
  const pointerOpen = useRef(false);

  const clearDelay = () => {
    if (delayRef.current != null) {
      window.clearTimeout(delayRef.current);
      delayRef.current = null;
    }
  };

  const placeAt = (x: number, y: number) => {
    let place: "top" | "bottom" = "top";
    if (y < 96) place = "bottom";
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

  const hide = () => {
    pointerOpen.current = false;
    pendingPtr.current = null;
    clearDelay();
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    setOpen(false);
    setCoords(null);
  };

  useEffect(() => {
    return () => {
      clearDelay();
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  useEffect(() => {
    if (truncated !== false) return;
    pointerOpen.current = false;
    pendingPtr.current = null;
    if (delayRef.current != null) {
      window.clearTimeout(delayRef.current);
      delayRef.current = null;
    }
    setOpen(false);
    setCoords(null);
  }, [truncated]);

  const showFromPointer = (e: MouseEvent<HTMLHeadingElement>) => {
    const overflows =
      truncated ?? lineClampOverflows(e.currentTarget);
    if (!overflows) return;
    pointerOpen.current = true;
    const { clientX, clientY } = e;
    placeAt(clientX, clientY);
    clearDelay();
    delayRef.current = window.setTimeout(() => {
      delayRef.current = null;
      if (pointerOpen.current) setOpen(true);
    }, SHOW_DELAY_MS);
  };

  const followPointer = (e: MouseEvent<HTMLHeadingElement>) => {
    if (!pointerOpen.current) return;
    pendingPtr.current = { x: e.clientX, y: e.clientY };
    if (rafRef.current != null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const p = pendingPtr.current;
      if (p) placeAt(p.x, p.y);
    });
  };

  const tooltip =
    open && coords
      ? createPortal(
          <span
            id={tipId}
            role="tooltip"
            className="ui-panel ui-panel-legible pointer-events-none fixed z-[200] w-72 max-w-[calc(100vw-1.5rem)] break-words rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-left text-xs font-medium leading-relaxed text-gray-100 shadow-xl ring-1 ring-ink-700"
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
    <>
      <h3
        className={className}
        style={style}
        aria-describedby={open ? tipId : undefined}
        onMouseEnter={showFromPointer}
        onMouseMove={followPointer}
        onMouseLeave={hide}
      >
        {text}
      </h3>
      {tooltip}
    </>
  );
}
