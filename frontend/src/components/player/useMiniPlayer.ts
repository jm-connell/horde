import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import {
  miniFrameFromNorthWestResize,
  type MiniPlayerBox,
} from "../../utils/miniPlayerLayout";
import {
  CONTROLS_HIDE_DELAY_MS,
  MAX_MINI_WIDTH,
  MIN_MINI_WIDTH,
} from "./constants";

interface Options {
  isMini: boolean;
  playing: boolean;
  isMobile: boolean;
  playerRootRef: RefObject<HTMLDivElement>;
  /** Set while a drag is in flight so the click that ends it doesn't toggle play. */
  suppressClick: { current: boolean };
  miniWidth: number | null;
  onMiniResize?: (
    width: number,
    origin: { left: number; top: number; height: number }
  ) => void;
  onMiniMove?: (left: number, top: number) => void;
  onMiniMoveEnd?: () => void;
}

/**
 * Mini player behaviour: the control strip that hides while playing, dragging
 * the whole player, and resizing from its top-left corner.
 */
export function useMiniPlayer({
  isMini,
  playing,
  isMobile,
  playerRootRef,
  suppressClick,
  miniWidth,
  onMiniResize,
  onMiniMove,
  onMiniMoveEnd,
}: Options) {
  const [miniControlsVisible, setMiniControlsVisible] = useState(true);
  const miniHideTimer = useRef<number | null>(null);
  const miniResizeDrag = useRef<{
    startX: number;
    startWidth: number;
    startBox: MiniPlayerBox;
  } | null>(null);
  const miniMoveDrag = useRef<{
    startX: number;
    startY: number;
    origLeft: number;
    origTop: number;
    pointerId: number;
    moved: boolean;
  } | null>(null);

  // Window listeners of the drag in flight, so unmounting mid-drag removes them.
  const dragCleanups = useRef(new Set<() => void>());
  useEffect(() => {
    const cleanups = dragCleanups.current;
    return () => {
      cleanups.forEach((fn) => fn());
      cleanups.clear();
    };
  }, []);

  const clearMiniHideTimer = useCallback(() => {
    if (miniHideTimer.current !== null) {
      clearTimeout(miniHideTimer.current);
      miniHideTimer.current = null;
    }
  }, []);

  const scheduleHideMiniControls = useCallback(() => {
    clearMiniHideTimer();
    if (!playing) return;
    miniHideTimer.current = window.setTimeout(() => {
      setMiniControlsVisible(false);
      miniHideTimer.current = null;
    }, CONTROLS_HIDE_DELAY_MS);
  }, [playing, clearMiniHideTimer]);

  const revealMiniControls = useCallback(() => {
    setMiniControlsVisible(true);
    scheduleHideMiniControls();
  }, [scheduleHideMiniControls]);

  useEffect(() => {
    if (!isMini) return;
    if (!playing) {
      clearMiniHideTimer();
      setMiniControlsVisible(true);
    } else {
      scheduleHideMiniControls();
    }
  }, [isMini, playing, clearMiniHideTimer, scheduleHideMiniControls]);

  useEffect(() => () => clearMiniHideTimer(), [clearMiniHideTimer]);

  const clampMiniWidth = useCallback((width: number) => {
    const max = Math.min(window.innerWidth * 0.9, MAX_MINI_WIDTH);
    return Math.min(max, Math.max(MIN_MINI_WIDTH, width));
  }, []);

  const onMiniResizePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      const rect = playerRootRef.current?.getBoundingClientRect();
      const startWidth = rect?.width ?? miniWidth ?? (isMobile ? 224 : 704);
      const startBox: MiniPlayerBox = rect
        ? {
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
          }
        : {
            left: 0,
            top: 0,
            width: startWidth,
            height: startWidth * (9 / 16),
          };
      miniResizeDrag.current = {
        startX: e.clientX,
        startWidth,
        startBox,
      };

      const onMove = (ev: PointerEvent) => {
        if (!miniResizeDrag.current || !onMiniResize) return;
        const {
          startX,
          startWidth: sw,
          startBox: box,
        } = miniResizeDrag.current;
        const nextWidth = clampMiniWidth(sw + (startX - ev.clientX));
        const frame = miniFrameFromNorthWestResize(box, nextWidth);
        onMiniResize(frame.width, {
          left: frame.left,
          top: frame.top,
          height: frame.height,
        });
      };
      const detach = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onEnd);
        window.removeEventListener("pointercancel", onEnd);
        dragCleanups.current.delete(detach);
      };
      const onEnd = () => {
        miniResizeDrag.current = null;
        detach();
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onEnd);
      window.addEventListener("pointercancel", onEnd);
      dragCleanups.current.add(detach);
    },
    [playerRootRef, miniWidth, isMobile, clampMiniWidth, onMiniResize]
  );

  const onMiniMovePointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      if (!onMiniMove || !isMini) return;
      if (e.button !== 0 && e.pointerType === "mouse") return;
      const hit = e.target as HTMLElement | null;
      if (
        hit?.closest("button, input, select, textarea, a, [data-mini-no-drag]")
      ) {
        return;
      }
      // Don't preventDefault here — that would swallow video click-to-play.
      const root = playerRootRef.current;
      if (!root) return;
      const rect = root.getBoundingClientRect();
      miniMoveDrag.current = {
        startX: e.clientX,
        startY: e.clientY,
        origLeft: rect.left,
        origTop: rect.top,
        pointerId: e.pointerId,
        moved: false,
      };
      // Window listeners keep tracking when the pointer outruns the mini.
      const onMove = (ev: PointerEvent) => {
        if (!miniMoveDrag.current || !onMiniMove) return;
        if (ev.pointerId !== miniMoveDrag.current.pointerId) return;
        const { startX, startY, origLeft, origTop } = miniMoveDrag.current;
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        if (!miniMoveDrag.current.moved && dx * dx + dy * dy < 16) return;
        if (!miniMoveDrag.current.moved) {
          miniMoveDrag.current.moved = true;
          suppressClick.current = true;
        }
        ev.preventDefault();
        onMiniMove(origLeft + dx, origTop + dy);
      };
      const detach = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onEnd);
        window.removeEventListener("pointercancel", onEnd);
        dragCleanups.current.delete(detach);
      };
      const onEnd = (ev: PointerEvent) => {
        if (
          miniMoveDrag.current &&
          ev.pointerId !== miniMoveDrag.current.pointerId
        ) {
          return;
        }
        const didMove = miniMoveDrag.current?.moved ?? false;
        miniMoveDrag.current = null;
        detach();
        if (didMove) onMiniMoveEnd?.();
        if (didMove) {
          window.setTimeout(() => {
            suppressClick.current = false;
          }, 0);
        }
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onEnd);
      window.addEventListener("pointercancel", onEnd);
      dragCleanups.current.add(detach);
    },
    [isMini, onMiniMove, onMiniMoveEnd, playerRootRef, suppressClick]
  );

  return {
    miniControlsVisible,
    revealMiniControls,
    onMiniResizePointerDown,
    onMiniMovePointerDown,
  };
}
