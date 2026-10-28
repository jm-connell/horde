import { useId } from "react";
import type { PlaylistVisibility } from "../types";

const OPTIONS: { value: PlaylistVisibility; label: string; hint: string }[] = [
  { value: "public", label: "App-wide", hint: "Everyone can see it." },
  { value: "private", label: "Private", hint: "Only you can see it." },
];

/**
 * App-wide or Private, as a two-option radio group. App-wide is disabled for an
 * account without the Manage playlists permission (the server refuses it too).
 */
export default function PlaylistVisibilityPicker({
  legend,
  value,
  onChange,
  canShare,
  disabled = false,
}: {
  legend: string;
  value: PlaylistVisibility;
  onChange: (next: PlaylistVisibility) => void;
  /** Whether this account may make an App-wide playlist. */
  canShare: boolean;
  disabled?: boolean;
}) {
  const name = useId();
  const hint = OPTIONS.find((o) => o.value === value)?.hint;
  return (
    <fieldset className="min-w-0">
      <legend className="mb-1.5 text-sm text-gray-400">{legend}</legend>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="inline-flex rounded-lg border border-ink-700 bg-ink-950 p-0.5">
          {OPTIONS.map((option) => {
            const blocked = option.value === "public" && !canShare;
            return (
              <label
                key={option.value}
                title={
                  blocked
                    ? "Sharing playlists with everyone needs the Manage playlists permission"
                    : undefined
                }
                className={`cursor-pointer rounded-md px-3 py-1 text-sm has-focus-visible:ring-2 has-focus-visible:ring-accent ${
                  value === option.value
                    ? "bg-accent/15 font-medium text-accent"
                    : "text-gray-400 hover:text-gray-200"
                } ${blocked || disabled ? "cursor-not-allowed opacity-50" : ""}`}
              >
                <input
                  type="radio"
                  name={name}
                  className="sr-only"
                  checked={value === option.value}
                  disabled={blocked || disabled}
                  onChange={() => onChange(option.value)}
                />
                {option.label}
              </label>
            );
          })}
        </div>
        <p className="min-w-40 flex-1 text-xs leading-snug text-muted">
          {hint}
        </p>
      </div>
    </fieldset>
  );
}
