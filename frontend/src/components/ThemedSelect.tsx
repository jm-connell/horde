import { useEffect, useId, useState } from "react";
import { FlipMenuPanel, useFlipMenu } from "../hooks/useFlipMenu";

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
  size?: "default" | "compact";
  align?: "left" | "right";
}

export default function ThemedSelect<T extends string>({
  value,
  options,
  onChange,
  className = "",
  buttonClassName = "",
  "aria-label": ariaLabel,
  disabled = false,
  size = "default",
  align = "left",
}: Props<T>) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const selected = options.find((o) => o.value === value) ?? options[0];
  const compact = size === "compact";
  const { flip, anchorRef } = useFlipMenu(open, compact ? 200 : 280);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (anchorRef.current?.contains(t)) return;
      if (t instanceof Element && t.closest("[data-horde='flip-menu']")) return;
      setOpen(false);
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
  }, [open, anchorRef]);

  const move = (dir: 1 | -1) => {
    const idx = options.findIndex((o) => o.value === value);
    const next = options[(idx + dir + options.length) % options.length];
    if (next) onChange(next.value);
  };

  return (
    <div ref={anchorRef} className={`relative inline-block ${className}`}>
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
        className={`ui-panel ui-menu ui-interactive inline-flex max-w-full items-center border border-ink-700 bg-ink-900 text-left outline-none hover:border-accent focus:border-accent disabled:cursor-not-allowed disabled:opacity-50 ${
          compact
            ? "gap-1 rounded px-1.5 py-0.5 text-xs text-gray-400"
            : "gap-2 rounded-lg px-3 py-2 text-sm text-gray-100"
        } ${buttonClassName}`}
      >
        <span className="min-w-0 truncate">{selected?.label ?? value}</span>
        <span className="shrink-0 text-gray-500" aria-hidden>
          ▾
        </span>
      </button>
      <FlipMenuPanel
        open={open}
        flip={flip}
        align={align}
        className={compact ? "!py-0.5" : ""}
      >
        <ul
          id={listId}
          role="listbox"
          className={
            compact ? "max-h-56 overflow-y-auto" : "max-h-64 overflow-y-auto"
          }
        >
          {options.map((opt) => {
            const active = opt.value === value;
            return (
              <li key={opt.value} role="option" aria-selected={active}>
                <button
                  type="button"
                  className={`flex w-full px-3 py-2 text-left transition-colors ${
                    compact ? "text-xs" : "text-sm"
                  } ${
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
      </FlipMenuPanel>
    </div>
  );
}
