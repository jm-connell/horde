interface Props {
  title?: string;
  playing: boolean;
  isMobile: boolean;
  controlsVisible: boolean;
  togglePlay: () => void;
  onTogglePiP: () => void;
  onExpand?: () => void;
  onClose?: () => void;
  /** Shown only when the host lets the mini player be resized. */
  onResizePointerDown?: (e: React.PointerEvent<HTMLDivElement>) => void;
}

/** Chrome drawn over the mini player: resize handle and the top control strip. */
export default function MiniPlayerFrame({
  title,
  playing,
  isMobile,
  controlsVisible,
  togglePlay,
  onTogglePiP,
  onExpand,
  onClose,
  onResizePointerDown,
}: Props) {
  return (
    <>
      {onResizePointerDown && (
        <div
          data-mini-no-drag
          className="absolute left-0 top-0 z-30 h-4 w-4 cursor-nwse-resize touch-none"
          style={{ touchAction: "none" }}
          title="Drag to resize"
          aria-label="Drag to resize mini player"
          onPointerDown={onResizePointerDown}
        />
      )}
      <div
        className={`absolute inset-x-0 top-0 z-10 flex items-center gap-1 bg-linear-to-b from-black/90 to-transparent px-2 pb-3 pt-1.5 text-gray-100 transition-opacity duration-300 ${
          controlsVisible
            ? "pointer-events-auto opacity-100"
            : "pointer-events-none opacity-0"
        }`}
      >
        <button
          type="button"
          onClick={togglePlay}
          className="flex min-h-[44px] min-w-[44px] touch-manipulation items-center justify-center text-2xl leading-none hover:text-accent"
          aria-label={playing ? "Pause" : "Play"}
        >
          {playing ? "❚❚" : "►"}
        </button>
        <span className="min-w-0 flex-1 truncate text-sm text-gray-200">
          {title}
        </span>
        {!isMobile &&
          typeof document !== "undefined" &&
          document.pictureInPictureEnabled && (
            <button
              type="button"
              data-mini-no-drag
              onClick={onTogglePiP}
              className="flex min-h-[44px] shrink-0 touch-manipulation items-center justify-center rounded-sm px-2 text-xs font-medium hover:text-accent"
              title="Picture in picture"
              aria-label="Picture in picture"
            >
              PiP
            </button>
          )}
        <button
          type="button"
          onClick={onExpand}
          className="flex min-h-[44px] min-w-[44px] shrink-0 touch-manipulation items-center justify-center text-lg hover:text-accent"
          title="Expand"
          aria-label="Expand"
        >
          ⤢
        </button>
        <button
          type="button"
          onClick={onClose}
          className="flex min-h-[44px] min-w-[44px] shrink-0 touch-manipulation items-center justify-center text-lg hover:text-accent"
          title="Close"
          aria-label="Close"
        >
          ✕
        </button>
      </div>
    </>
  );
}
