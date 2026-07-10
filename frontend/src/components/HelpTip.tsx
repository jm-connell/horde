import { useId, useState } from "react";

/** Hover/focus popover tip — more reliable than native title on Windows. */
export default function HelpTip({ text }: { text: string }) {
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
          className="ui-panel ui-panel-legible absolute bottom-full left-1/2 z-50 mb-2 w-64 -translate-x-1/2 rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-left text-xs leading-relaxed text-gray-300 shadow-xl ring-1 ring-ink-700"
        >
          {text}
        </span>
      )}
    </span>
  );
}
