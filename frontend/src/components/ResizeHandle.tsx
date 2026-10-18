import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

const KEY_STEP_PX = 16;

export type ResizeHandleProps = {
  /** "y" drags the bottom edge (height); "x" drags a column split. */
  axis: "x" | "y";
  label: string;
  /** Value when a drag (or key press) starts, e.g. the rendered height. */
  getStart: () => number;
  /** Map the start value and the pointer travel to a clamped new value. */
  toValue: (start: number, deltaPx: number) => number;
  /** Live updates while dragging. */
  onChange: (value: number) => void;
  /** The final value, to persist. */
  onCommit: (value: number) => void;
  /** Double-click: back to the default size. */
  onReset: () => void;
  /** The range a value can take, in the same unit as `getStart`. */
  valueMin: number;
  valueMax: number;
  className?: string;
};

function describe(axis: "x" | "y", value: number): string {
  // Heights are pixels; a column split is the left column's share.
  return axis === "y"
    ? `${Math.round(value)} pixels`
    : `${Math.round(value * 100)}%`;
}

/**
 * A subtle drag target for resizing a panel: invisible until its panel is
 * hovered, accent while dragged. Keyboard: arrows nudge (Shift for bigger steps).
 * Desktop only; callers do not render it on mobile.
 */
export default function ResizeHandle({
  axis,
  label,
  getStart,
  toValue,
  onChange,
  onCommit,
  onReset,
  valueMin,
  valueMax,
  className = "",
}: ResizeHandleProps) {
  const drag = useRef<{ origin: number; start: number; value: number } | null>(
    null
  );
  // A focusable separator reports its position (aria-valuenow). A default
  // size is "auto", so it is measured when the handle is focused or used,
  // not on every render.
  const [valueNow, setValueNow] = useState<number | null>(null);
  const shown = Math.min(Math.max(valueNow ?? valueMin, valueMin), valueMax);
  const report = (value: number) => setValueNow(value);

  const coord = (e: PointerEvent) => (axis === "y" ? e.clientY : e.clientX);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const start = getStart();
    drag.current = { origin: coord(e), start, value: start };
    report(start);
    e.currentTarget.setPointerCapture(e.pointerId);
    document.body.style.cursor = axis === "y" ? "row-resize" : "col-resize";
    document.body.style.userSelect = "none";
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    d.value = toValue(d.start, coord(e) - d.origin);
    onChange(d.value);
    report(d.value);
  };

  const endDrag = (e: PointerEvent<HTMLDivElement>, keep: boolean) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    if (keep && d.value !== d.start) onCommit(d.value);
    else {
      onChange(d.start);
      report(d.start);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const back = axis === "y" ? "ArrowUp" : "ArrowLeft";
    const forward = axis === "y" ? "ArrowDown" : "ArrowRight";
    if (e.key !== back && e.key !== forward) return;
    e.preventDefault();
    const step = e.key === forward ? KEY_STEP_PX : -KEY_STEP_PX;
    const value = toValue(getStart(), e.shiftKey ? step * 4 : step);
    onCommit(value);
    report(value);
  };

  const reset = () => {
    onReset();
    // The default may be "auto": measure it once it is laid out.
    requestAnimationFrame(() => report(getStart()));
  };

  const bar =
    axis === "y"
      ? "h-1 w-12 group-hover/resize:w-16"
      : "h-12 w-1 group-hover/resize:h-16";

  /* eslint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex -- a focusable separator is the ARIA window-splitter pattern; it takes pointer and arrow-key input */
  return (
    <div
      role="separator"
      aria-orientation={axis === "y" ? "horizontal" : "vertical"}
      aria-label={label}
      aria-valuenow={shown}
      aria-valuemin={valueMin}
      aria-valuemax={valueMax}
      aria-valuetext={describe(axis, shown)}
      title={`${label} (double-click to reset)`}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => endDrag(e, true)}
      onPointerCancel={(e) => endDrag(e, false)}
      onDoubleClick={reset}
      onFocus={() => report(getStart())}
      onKeyDown={onKeyDown}
      className={`group/resize z-[3] flex touch-none select-none items-center justify-center opacity-0 outline-none transition-opacity duration-150 hover:opacity-100 focus-visible:opacity-100 active:opacity-100 group-hover:opacity-60 ${
        axis === "y" ? "cursor-row-resize" : "cursor-col-resize"
      } ${className}`}
    >
      <span
        aria-hidden
        className={`${bar} rounded-full bg-gray-500 transition-all duration-150 group-hover/resize:bg-accent group-focus-visible/resize:bg-accent group-active/resize:bg-accent`}
      />
    </div>
  );
  /* eslint-enable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */
}
