import { usePlaybackActions } from "../context/PlaybackContext";
import type { QueueEntry } from "../context/playbackQueue";

/**
 * "+ Queue" over a card's thumbnail, shown while its `group` is hovered (or
 * the button is focused). Inside a link, it adds without opening the video.
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
  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        addToQueue(entry);
      }}
      title="Add to queue"
      className={`pointer-events-none absolute z-30 rounded bg-black/70 px-2 py-1 text-xs font-medium text-white opacity-0 transition-opacity hover:bg-accent hover:text-ink-950 focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 ${className}`}
    >
      + Queue
    </button>
  );
}
