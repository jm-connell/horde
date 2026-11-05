import { useEffect, useRef, useState } from "react";
import { FlipMenuPanel, useFlipMenu } from "../../hooks/useFlipMenu";
import { MoreIcon } from "../icons";

/**
 * "Why this video?", "Not interested", "Don't recommend this channel" and, on
 * a live card, "Hide live streams from this channel" on a recommendation card.
 */
export default function RecMenu({
  channel,
  onWhy,
  onNotInterested,
  onBlockChannel,
  onHideLive,
  className,
}: {
  channel: string | null;
  /** Show how the feed placed it (Recommended only). */
  onWhy?: () => void;
  onNotInterested?: () => void;
  onBlockChannel?: () => void;
  /** A live card: hide the channel's live streams (it stays followed). */
  onHideLive?: () => void;
  /** Positions the trigger; it must be a positioned box (relative by default). */
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const { flip, anchorRef } = useFlipMenu(open, 120);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      const t = e.target as Node;
      if (anchorRef.current?.contains(t)) return;
      if (t instanceof Element && t.closest("[data-horde='flip-menu']")) return;
      setOpen(false);
    };
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [open, anchorRef]);

  const itemClass =
    "block w-full px-4 py-2 text-left text-sm text-gray-200 hover:bg-ink-700";

  return (
    <div ref={anchorRef} className={className || "relative"}>
      <button
        ref={triggerRef}
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="ui-interactive rounded-lg bg-ink-950/80 p-1.5 text-gray-200 ring-1 ring-ink-700 backdrop-blur-sm hover:text-accent"
        title="Tune recommendations"
        aria-label="Tune recommendations"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <MoreIcon />
      </button>
      <FlipMenuPanel
        open={open}
        flip={flip}
        align="right"
        className="w-60"
        menu={{
          label: "Tune recommendations",
          onClose: () => setOpen(false),
          triggerRef,
        }}
      >
        {onWhy && (
          <button
            type="button"
            role="menuitem"
            className={itemClass}
            onClick={() => {
              setOpen(false);
              onWhy();
            }}
          >
            Why this video?
          </button>
        )}
        {onHideLive && (
          <button
            type="button"
            role="menuitem"
            className={itemClass}
            onClick={() => {
              setOpen(false);
              onHideLive();
            }}
          >
            Hide live streams from {channel || "this channel"}
          </button>
        )}
        {onNotInterested && (
          <button
            type="button"
            role="menuitem"
            className={itemClass}
            onClick={() => {
              setOpen(false);
              onNotInterested();
            }}
          >
            Not interested
          </button>
        )}
        {channel && onBlockChannel && (
          <button
            type="button"
            role="menuitem"
            className={itemClass}
            onClick={() => {
              setOpen(false);
              onBlockChannel();
            }}
          >
            Don&apos;t recommend {channel}
          </button>
        )}
      </FlipMenuPanel>
    </div>
  );
}
