import { Fragment, useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { FlipMenuPanel, useFlipMenu } from "../hooks/useFlipMenu";

export interface ThemedSelectOption<T extends string = string> {
  value: T;
  label: string;
  /** Optional trailing note (e.g. OpenRouter $/M). Stays visible when the label truncates. */
  hint?: string;
  /** Consecutive options with the same group get a section header. */
  group?: string;
}

export function filterThemedSelectOptions<T extends string>(
  options: ThemedSelectOption<T>[],
  query: string
): ThemedSelectOption<T>[] {
  const q = query.trim().toLowerCase();
  if (!q) return options;
  return options.filter(
    (o) =>
      o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q)
  );
}

interface Props<T extends string> {
  value: T;
  options: ThemedSelectOption<T>[];
  onChange: (value: T) => void;
  className?: string;
  buttonClassName?: string;
  listClassName?: string;
  "aria-label"?: string;
  disabled?: boolean;
  size?: "default" | "compact";
  align?: "left" | "right";
  /** Typeable combobox: focus/type opens the filtered list. */
  searchable?: boolean;
  searchPlaceholder?: string;
}

export default function ThemedSelect<T extends string>({
  value,
  options,
  onChange,
  className = "",
  buttonClassName = "",
  listClassName = "",
  "aria-label": ariaLabel,
  disabled = false,
  size = "default",
  align = "left",
  searchable = false,
  searchPlaceholder = "Search…",
}: Props<T>) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const selected = options.find((o) => o.value === value) ?? options[0];
  const compact = size === "compact";
  const { flip, anchorRef } = useFlipMenu(open, compact ? 200 : 320);
  const visible = useMemo(
    () =>
      searchable ? filterThemedSelectOptions(options, query) : options,
    [searchable, options, query]
  );

  const close = () => {
    setOpen(false);
    setQuery("");
  };

  useEffect(() => {
    if (!open) return;
    const selectedIdx = visible.findIndex((o) => o.value === value);
    setActiveIndex(selectedIdx >= 0 ? selectedIdx : 0);
  }, [open, query]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (anchorRef.current?.contains(t)) return;
      if (t instanceof Element && t.closest("[data-horde='flip-menu']")) return;
      close();
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, anchorRef]);

  const pick = (next: T) => {
    onChange(next);
    close();
  };

  const move = (dir: 1 | -1) => {
    if (searchable) {
      if (!visible.length) return;
      setActiveIndex(
        (i) => (i + dir + visible.length) % visible.length
      );
      return;
    }
    const idx = options.findIndex((o) => o.value === value);
    const next = options[(idx + dir + options.length) % options.length];
    if (next) onChange(next.value);
  };

  const listClass =
    listClassName ||
    (compact ? "max-h-56 overflow-y-auto" : "max-h-64 overflow-y-auto");

  const optionList = (
    <ul id={listId} role="listbox" className={listClass}>
      {visible.length === 0 ? (
        <li className="px-3 py-2 text-sm text-gray-500">No matching models</li>
      ) : (
        visible.map((opt, i) => {
          const active = opt.value === value;
          const highlighted = searchable && i === activeIndex;
          const showGroup = Boolean(
            opt.group && opt.group !== visible[i - 1]?.group
          );
          const optId = `${listId}-opt-${i}`;
          return (
            <Fragment key={opt.value}>
              {showGroup ? (
                <li
                  role="presentation"
                  className="sticky top-0 z-[1] border-b border-ink-800 bg-ink-900 px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider text-gray-500"
                >
                  {opt.group}
                </li>
              ) : null}
              <li role="option" aria-selected={active} id={optId}>
                <button
                  type="button"
                  className={`flex w-full items-start gap-3 px-3 py-2 text-left transition-colors ${
                    compact ? "text-xs" : "text-sm"
                  } ${
                    active
                      ? "bg-accent/15 text-accent"
                      : highlighted
                        ? "bg-ink-800 text-gray-100"
                        : "text-gray-200 hover:bg-ink-800 hover:text-gray-100"
                  }`}
                  onMouseEnter={() => searchable && setActiveIndex(i)}
                  onClick={() => pick(opt.value)}
                >
                  <span className="min-w-0 flex-1 whitespace-normal">
                    {opt.label}
                  </span>
                  {opt.hint ? (
                    <span
                      className={`shrink-0 tabular-nums ${
                        active ? "text-accent/80" : "text-gray-500"
                      } ${compact ? "text-[10px]" : "text-xs"}`}
                      title="USD per 1M tokens"
                    >
                      {opt.hint}
                    </span>
                  ) : null}
                </button>
              </li>
            </Fragment>
          );
        })
      )}
    </ul>
  );

  const onTriggerKeyDown = (e: ReactKeyboardEvent<HTMLElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) setOpen(true);
      else move(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) setOpen(true);
      else move(-1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (searchable) {
        if (!open) setOpen(true);
        else if (visible[activeIndex]) pick(visible[activeIndex].value);
      } else {
        setOpen((v) => !v);
      }
    } else if (!searchable && e.key === " ") {
      e.preventDefault();
      setOpen((v) => !v);
    }
  };

  useEffect(() => {
    if (!open || !searchable) return;
    const el = document.getElementById(`${listId}-opt-${activeIndex}`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open, searchable, listId]);

  return (
    <div ref={anchorRef} className={`relative inline-block ${className}`}>
      {searchable ? (
        <div
          className={`ui-panel ui-menu ui-interactive inline-flex max-w-full items-center border border-ink-700 bg-ink-900 text-left outline-none focus-within:border-accent ${
            compact
              ? "gap-1 rounded px-1.5 py-0.5"
              : "gap-2 rounded-lg px-3 py-2"
          } ${disabled ? "cursor-not-allowed opacity-50" : ""} ${buttonClassName}`}
          onMouseDown={(e) => {
            if (disabled) return;
            if (e.target === inputRef.current) return;
            e.preventDefault();
            inputRef.current?.focus();
            setOpen(true);
          }}
        >
          <input
            ref={inputRef}
            type="text"
            disabled={disabled}
            role="combobox"
            aria-label={ariaLabel}
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={
              open && visible[activeIndex]
                ? `${listId}-opt-${activeIndex}`
                : undefined
            }
            autoComplete="off"
            spellCheck={false}
            value={query}
            placeholder={
              query
                ? searchPlaceholder
                : selected?.label ?? searchPlaceholder
            }
            onFocus={() => !disabled && setOpen(true)}
            onChange={(e) => {
              setQuery(e.target.value);
              if (!open) setOpen(true);
            }}
            onKeyDown={onTriggerKeyDown}
            className={`min-w-0 flex-1 bg-transparent outline-none placeholder:text-gray-400 ${
              compact ? "text-xs text-gray-400" : "text-sm text-gray-100"
            }`}
          />
          {!query && selected?.hint ? (
            <span
              className="shrink-0 text-xs tabular-nums text-gray-500"
              title="USD per 1M tokens"
            >
              {selected.hint}
            </span>
          ) : null}
          <span className="shrink-0 text-gray-500" aria-hidden>
            ▾
          </span>
        </div>
      ) : (
        <button
          type="button"
          disabled={disabled}
          aria-label={ariaLabel}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => !disabled && setOpen((v) => !v)}
          onKeyDown={onTriggerKeyDown}
          className={`ui-panel ui-menu ui-interactive inline-flex max-w-full items-center border border-ink-700 bg-ink-900 text-left outline-none hover:border-accent focus:border-accent disabled:cursor-not-allowed disabled:opacity-50 ${
            compact
              ? "gap-1 rounded px-1.5 py-0.5 text-xs text-gray-400"
              : "gap-2 rounded-lg px-3 py-2 text-sm text-gray-100"
          } ${buttonClassName}`}
        >
          <span className="min-w-0 truncate">{selected?.label ?? value}</span>
          {selected?.hint ? (
            <span
              className="shrink-0 text-xs tabular-nums text-gray-500"
              title="USD per 1M tokens"
            >
              {selected.hint}
            </span>
          ) : null}
          <span className="shrink-0 text-gray-500" aria-hidden>
            ▾
          </span>
        </button>
      )}
      <FlipMenuPanel
        open={open}
        flip={flip}
        align={align}
        className={compact ? "!py-0.5" : ""}
      >
        {optionList}
      </FlipMenuPanel>
    </div>
  );
}
