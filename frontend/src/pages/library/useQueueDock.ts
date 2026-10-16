import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { usePlaybackSession } from "../../context/PlaybackContext";

// Fixed queue overlay width (w-[26rem]) — dock to bottom when grid extends into this zone.
const QUEUE_RESERVE_PX = 416;

/**
 * Where the playback queue panel sits: beside the library when there is room
 * to its right, docked along the bottom otherwise.
 */
export function useQueueDock(input: {
  /** The queue is hidden in select mode. */
  selectMode: boolean;
  /** What moves the library's right edge; a change re-checks the placement. */
  sidebarCollapsed: boolean;
  videoCount: number;
  showContinueRow: boolean;
  loading: boolean;
}) {
  const { sidebarCollapsed, videoCount, showContinueRow, loading } = input;
  const { queue } = usePlaybackSession();
  const mainContentRef = useRef<HTMLDivElement>(null);
  const [queueDockedBottom, setQueueDockedBottom] = useState(true);
  const showQueuePanel = queue.length > 0 && !input.selectMode;

  const updateQueuePlacement = useCallback(() => {
    if (window.innerWidth < 1024) {
      setQueueDockedBottom(true);
      return;
    }
    const el = mainContentRef.current;
    if (!el) return;
    setQueueDockedBottom(
      el.getBoundingClientRect().right > window.innerWidth - QUEUE_RESERVE_PX
    );
  }, []);

  useLayoutEffect(() => {
    if (!showQueuePanel) return;
    updateQueuePlacement();
    const el = mainContentRef.current;
    const ro = new ResizeObserver(updateQueuePlacement);
    if (el) ro.observe(el);
    window.addEventListener("resize", updateQueuePlacement);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", updateQueuePlacement);
    };
  }, [
    showQueuePanel,
    updateQueuePlacement,
    sidebarCollapsed,
    videoCount,
    showContinueRow,
    loading,
  ]);

  return {
    mainContentRef,
    showQueuePanel,
    queueDockedBottom,
    dockedBottom: showQueuePanel && queueDockedBottom,
  };
}
