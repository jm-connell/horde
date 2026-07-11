import { useId, useState } from "react";

/** Hover/focus popover tip — more reliable than native title on Windows. */
export default function HelpTip({
  text,
  placement = "top",
}: {
  text: string;
  /** Prefer "bottom" near the top of the viewport so the tip stays visible. */
  placement?: "top" | "bottom";
}) {
  const [open, setOpen] = useState(false);
  const tipId = useId();

  return (
    <span
      className="relative inline-flex"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        className="cursor-help text-gray-600 hover:text-gray-400"
        aria-label="More info"
        aria-describedby={open ? tipId : undefined}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
      >
        (?)
      </button>
      {open && (
        <span
          id={tipId}
          role="tooltip"
          className={`ui-panel ui-panel-legible absolute left-1/2 z-50 w-64 -translate-x-1/2 rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-left text-xs leading-relaxed text-gray-300 shadow-xl ring-1 ring-ink-700 ${
            placement === "bottom"
              ? "top-full mt-2"
              : "bottom-full mb-2"
          }`}
        >
          {text}
        </span>
      )}
    </span>
  );
}
