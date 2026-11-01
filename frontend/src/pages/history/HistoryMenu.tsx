import { useEffect, useRef, useState } from "react";
import { MoreIcon } from "../../components/icons";
import { FlipMenuPanel, useFlipMenu } from "../../hooks/useFlipMenu";

/** "Don't use for recommendations" / "Remove from history" on a History card. */
export default function HistoryMenu({
  title,
  excluded,
  onTaste,
  onRemove,
  className,
}: {
  title: string;
  excluded: boolean;
  onTaste: () => void;
  onRemove: () => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const { flip, anchorRef } = useFlipMenu(open, 100);
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
        title="History options"
        aria-label={`History options for ${title}`}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <MoreIcon />
      </button>
      <FlipMenuPanel
        open={open}
        flip={flip}
        align="right"
        className="w-64"
        menu={{
          label: "History options",
          onClose: () => setOpen(false),
          triggerRef,
        }}
      >
        <button
          type="button"
          role="menuitem"
          className={itemClass}
          onClick={() => {
            setOpen(false);
            onTaste();
          }}
        >
          {excluded
            ? "Use for recommendations again"
            : "Don't use for recommendations"}
        </button>
        <button
          type="button"
          role="menuitem"
          className={`${itemClass} text-danger`}
          onClick={() => {
            setOpen(false);
            onRemove();
          }}
        >
          Remove from history
        </button>
      </FlipMenuPanel>
    </div>
  );
}
