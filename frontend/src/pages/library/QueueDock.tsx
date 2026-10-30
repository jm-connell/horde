import { useRef } from "react";
import PlaybackQueue from "../../components/PlaybackQueue";
import {
  usePlaybackLayout,
  usePlaybackSession,
} from "../../context/PlaybackContext";
import { useAnimatedLayout } from "../../hooks/useAnimatedLayout";
import {
  queueDockAlignClass,
  queueDockStyle,
} from "../../utils/miniPlayerLayout";

/** The queue as a fixed panel at the right edge (wide screens). */
export function QueueSidePanel() {
  return (
    <div className="pointer-events-none fixed inset-y-0 right-0 z-40 hidden w-104 p-3 pt-20 lg:block">
      <div className="pointer-events-auto ml-auto flex max-h-full w-96 flex-col overflow-hidden">
        <PlaybackQueue className="max-h-[calc(100dvh-6rem)] overflow-y-auto shadow-2xl" />
      </div>
    </div>
  );
}

/** The queue docked along the bottom, clear of the mini-player. */
export function QueueBottomDock({ viewportWidth }: { viewportWidth: number }) {
  const { miniPlayerActive } = usePlaybackSession();
  const { miniPlayerRect } = usePlaybackLayout();
  const rect = miniPlayerActive ? miniPlayerRect : null;
  const style = queueDockStyle(rect, { viewportWidth });
  // Glide across when the mini player opens or closes instead of jumping.
  const panelRef = useRef<HTMLDivElement>(null);
  useAnimatedLayout(panelRef, "left" in style ? "left" : "right");
  return (
    <div style={style}>
      <div
        ref={panelRef}
        className={`pointer-events-auto w-96 ${queueDockAlignClass(rect, {
          viewportWidth,
        })}`}
      >
        <PlaybackQueue
          collapsible
          listMaxHeightClass="max-h-[20vh] lg:max-h-[30vh]"
          className="shadow-2xl"
        />
      </div>
    </div>
  );
}
