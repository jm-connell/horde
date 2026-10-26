import { useEffect, useState } from "react";
import { usePlaybackActions } from "../context/PlaybackContext";
import type { QueueEntry } from "../context/playbackQueue";

/** How long "Queued" stays up after a click. */
const ADDED_MS = 1400;

/**
 * "+ Queue" over a card's thumbnail, shown while its `group` is hovered (or
 * the button is focused). Inside a link, it adds without opening the video,
 * then reads "Queued" for a moment so the click is acknowledged.
 */
export default function QueueButton({
  entry,
  className = "right-2 top-2",
}: {
  entry: QueueEntry;
  /** Where in the thumbnail it sits. */
  className?: string;
}) {
  const { addToQueue } = usePlaybackActions();
  const [added, setAdded] = useState(false);

  useEffect(() => {
    if (!added) return;
    const t = window.setTimeout(() => setAdded(false), ADDED_MS);
    return () => window.clearTimeout(t);
  }, [added]);

  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        addToQueue(entry);
        setAdded(true);
      }}
      title="Add to queue"
      className={`absolute z-30 rounded-sm px-2 py-1 text-xs font-medium transition-[opacity,background-color,color] duration-150 ease-out focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 ${
        added
          ? "bg-accent text-ink-950 opacity-100"
          : "pointer-events-none bg-black/70 text-white opacity-0 hover:bg-accent hover:text-ink-950"
      } ${className}`}
    >
      <span aria-live="polite">{added ? "✓ Queued" : "+ Queue"}</span>
    </button>
  );
}
