import { useEffect, useRef, useState } from "react";
import type { ChannelStat } from "../types";

interface Props {
  value: string;
  onChange: (value: string) => void;
  channels: ChannelStat[];
  placeholder?: string;
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
}: Props) {
  const names = channels.map((c) => c.channel);
  const useCombobox = channels.length >= COMBOBOX_THRESHOLD;

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
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [open]);

  const matches = value.trim()
    ? names.filter((n) => n.toLowerCase().includes(value.toLowerCase()))
    : names;

  return (
    <div ref={ref} className="relative">
      <input
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        placeholder={placeholder ?? "Search channels…"}
        className={inputClass}
      />
      {open && matches.length > 0 && (
        <ul className="absolute z-20 mt-1 max-h-60 w-full overflow-auto rounded-lg bg-ink-800 py-1 shadow-2xl ring-1 ring-ink-600">
          {matches.slice(0, 50).map((name) => (
            <li key={name}>
              <button
                type="button"
                onClick={() => {
                  onChange(name);
                  setOpen(false);
                }}
                className="block w-full px-3 py-2 text-left text-sm text-gray-200 hover:bg-ink-700"
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
