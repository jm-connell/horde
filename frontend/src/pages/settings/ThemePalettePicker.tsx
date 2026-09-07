import type { Theme } from "../../hooks/useSettings";
import { THEMES } from "./constants";

export default function ThemePalettePicker({
  theme,
  onChange,
}: {
  theme: Theme;
  onChange: (theme: Theme) => void;
}) {
  const options = THEMES.filter((t) => t.value !== "custom");
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {options.map((opt) => {
        const active = theme === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            aria-pressed={active}
            className={`ui-panel ui-interactive flex items-center gap-3 rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
              active
                ? "border-accent/50 bg-accent/15 text-accent"
                : "border-ink-700 bg-ink-900 text-gray-300 hover:border-accent hover:text-gray-100"
            }`}
          >
            <span
              className="h-4 w-4 shrink-0 rounded-full ring-1 ring-white/20"
              style={{ background: opt.preview }}
              aria-hidden
            />
            <span className="min-w-0 truncate">{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
}
