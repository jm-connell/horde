import HelpTip from "./HelpTip";

/** Always-visible “why this matched” control for search result thumbnails. */
export default function MatchReasonBadge({
  text,
  className = "absolute top-1.5 right-1.5 z-30",
}: {
  text: string | null | undefined;
  className?: string;
}) {
  if (!text) return null;
  return (
    <div
      className={className}
      data-horde="match-reason"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onPointerDown={(e) => {
        e.stopPropagation();
      }}
    >
      <HelpTip text={text} placement="bottom">
        <button
          type="button"
          className="flex h-6 w-6 items-center justify-center rounded-full bg-black/80 text-xs font-bold text-white ring-1 ring-white/50 hover:bg-accent hover:text-ink-950 hover:ring-accent"
          aria-label="Why this video matched"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          ?
        </button>
      </HelpTip>
    </div>
  );
}
