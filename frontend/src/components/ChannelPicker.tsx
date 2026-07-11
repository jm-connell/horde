import { useEffect, useMemo, useRef, useState } from "react";
import type { ChannelStat } from "../types";

interface Props {
  value: string;
  onChange: (value: string) => void;
  channels: ChannelStat[];
  placeholder?: string;
  /** Prefer typeahead + Tab complete over a plain <select>. */
  autocomplete?: boolean;
}

const COMBOBOX_THRESHOLD = 30;
const CUSTOM = "__custom__";

const inputClass =
  "w-full rounded-lg border border-ink-700 bg-ink-950 px-3 py-2.5 text-sm text-gray-100 placeholder-gray-500 outline-none focus:border-accent";

export default function ChannelPicker({
  value,
  onChange,
  channels,
  placeholder,
  autocomplete = false,
}: Props) {
  const names = channels.map((c) => c.channel);
  const useCombobox = autocomplete || channels.length >= COMBOBOX_THRESHOLD;

  if (useCombobox) {
    return (
      <Combobox
        value={value}
        onChange={onChange}
        names={names}
        placeholder={placeholder}
      />
    );
  }

  return (
    <SelectPicker
      value={value}
      onChange={onChange}
      names={names}
      placeholder={placeholder}
    />
  );
}

function SelectPicker({
  value,
  onChange,
  names,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  names: string[];
  placeholder?: string;
}) {
  const [custom, setCustom] = useState(false);

  if (custom) {
    return (
      <div className="flex gap-2">
        <input
          autoFocus
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className={inputClass}
        />
        <button
          type="button"
          onClick={() => {
            setCustom(false);
            onChange("");
          }}
          className="shrink-0 rounded-lg bg-ink-800 px-3 text-sm text-gray-300 hover:bg-ink-700"
          title="Choose from list"
        >
          ↩
        </button>
      </div>
    );
  }

  // Surface an autofilled/detected channel that isn't in the known list so the
  // select still shows the active value rather than appearing empty.
  const showCurrent = value !== "" && !names.includes(value);

  return (
    <select
      value={value}
      onChange={(e) => {
        if (e.target.value === CUSTOM) {
          setCustom(true);
          onChange("");
        } else {
          onChange(e.target.value);
        }
      }}
      className={inputClass}
    >
      <option value="">{placeholder ?? "Auto-detected"}</option>
      {showCurrent && <option value={value}>{value}</option>}
      {names.map((name) => (
        <option key={name} value={name}>
          {name}
        </option>
      ))}
      <option value={CUSTOM}>Custom…</option>
    </select>
  );
}

function rankMatches(query: string, names: string[]): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...names].sort((a, b) => a.localeCompare(b));
  const starts: string[] = [];
  const includes: string[] = [];
  for (const n of names) {
    const lower = n.toLowerCase();
    if (lower.startsWith(q)) starts.push(n);
    else if (lower.includes(q)) includes.push(n);
  }
  starts.sort((a, b) => a.localeCompare(b));
  includes.sort((a, b) => a.localeCompare(b));
  return [...starts, ...includes];
}

function Combobox({
  value,
  onChange,
  names,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  names: string[];
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [open]);

  const matches = useMemo(() => rankMatches(value, names), [value, names]);

  const tabSuggestion = useMemo(() => {
    const q = value.trim().toLowerCase();
    if (!q) return null;
    // Exact match — nothing to complete.
    if (names.some((n) => n.toLowerCase() === q)) return null;
    return matches.find((n) => n.toLowerCase().startsWith(q)) ?? null;
  }, [value, names, matches]);

  useEffect(() => {
    setHighlight(0);
  }, [value]);

  const accept = (name: string) => {
    onChange(name);
    setOpen(false);
    inputRef.current?.blur();
  };

  return (
    <div ref={ref} className="relative">
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "Tab" && tabSuggestion) {
            e.preventDefault();
            accept(tabSuggestion);
            return;
          }
          if (!open || matches.length === 0) return;
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setHighlight((h) => Math.min(h + 1, matches.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setHighlight((h) => Math.max(h - 1, 0));
          } else if (e.key === "Enter" && matches[highlight]) {
            e.preventDefault();
            accept(matches[highlight]);
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
        placeholder={placeholder ?? "Search channels…"}
        className={inputClass}
        autoComplete="off"
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
      />
      {tabSuggestion && open && (
        <p className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-500">
          Tab · {tabSuggestion}
        </p>
      )}
      {open && matches.length > 0 && (
        <ul className="absolute z-20 mt-1 max-h-60 w-full overflow-auto rounded-lg bg-ink-800 py-1 shadow-2xl ring-1 ring-ink-600">
          {matches.slice(0, 50).map((name, i) => (
            <li key={name}>
              <button
                type="button"
                onMouseEnter={() => setHighlight(i)}
                onClick={() => accept(name)}
                className={`block w-full px-3 py-2 text-left text-sm ${
                  i === highlight
                    ? "bg-ink-700 text-accent"
                    : "text-gray-200 hover:bg-ink-700"
                }`}
              >
                {name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
