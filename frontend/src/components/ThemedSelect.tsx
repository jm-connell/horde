import { useEffect, useId, useRef, useState } from "react";

export interface ThemedSelectOption<T extends string = string> {
  value: T;
  label: string;
}

interface Props<T extends string> {
  value: T;
  options: ThemedSelectOption<T>[];
  onChange: (value: T) => void;
  className?: string;
  buttonClassName?: string;
  "aria-label"?: string;
  disabled?: boolean;
}

export default function ThemedSelect<T extends string>({
  value,
  options,
  onChange,
  className = "",
  buttonClassName = "",
  "aria-label": ariaLabel,
  disabled = false,
}: Props<T>) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const selected = options.find((o) => o.value === value) ?? options[0];

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const move = (dir: 1 | -1) => {
    const idx = options.findIndex((o) => o.value === value);
    const next = options[(idx + dir + options.length) % options.length];
    if (next) onChange(next.value);
  };

  return (
    <div ref={rootRef} className={`relative inline-block ${className}`}>
      <button
        type="button"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => !disabled && setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            if (!open) setOpen(true);
            else move(1);
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            if (!open) setOpen(true);
            else move(-1);
          } else if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen((v) => !v);
          }
        }}
        className={`ui-panel ui-interactive inline-flex w-max max-w-full items-center gap-2 rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-left text-sm text-gray-100 outline-none hover:border-accent focus:border-accent disabled:cursor-not-allowed disabled:opacity-50 ${buttonClassName}`}
      >
        <span className="min-w-0 truncate">{selected?.label ?? value}</span>
        <span className="shrink-0 text-gray-500" aria-hidden>
          ▾
        </span>
      </button>
      {open && (
        <ul
          id={listId}
          role="listbox"
          className="ui-panel absolute left-0 z-50 mt-1 max-h-64 min-w-full overflow-y-auto rounded-lg border border-ink-700 bg-ink-900 py-1 shadow-xl ring-1 ring-ink-700"
        >
          {options.map((opt) => {
            const active = opt.value === value;
            return (
              <li key={opt.value} role="option" aria-selected={active}>
                <button
                  type="button"
                  className={`flex w-full px-3 py-2 text-left text-sm transition-colors ${
                    active
                      ? "bg-accent/15 text-accent"
                      : "text-gray-200 hover:bg-ink-800 hover:text-gray-100"
                  }`}
                  onClick={() => {
                    onChange(opt.value);
                    setOpen(false);
                  }}
                >
                  {opt.label}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
