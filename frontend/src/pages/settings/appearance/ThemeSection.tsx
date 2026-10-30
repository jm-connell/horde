import Collapse from "../../../components/Collapse";
import ThemedSelect from "../../../components/ThemedSelect";
import { INPUT, PANEL_BTN, THEMES } from "../constants";
import { Section } from "../ui";
import { useSettingsPage } from "../context";
import type { AppearanceState } from "../useAppearanceState";

export default function ThemeSection({
  appearance,
}: {
  appearance: AppearanceState;
}) {
  const { q, match, settings, update } = useSettingsPage();
  const {
    themeNameDraft,
    setThemeNameDraft,
    saveCurrentAsTheme,
    applyCustomTheme,
    deleteCustomTheme,
  } = appearance;

  return (
    <Section
      first
      anchor="theme"
      title="Theme"
      hidden={
        !!q &&
        !match(
          "theme",
          "color palette",
          "chrome",
          "custom",
          "saved themes",
          "save theme",
          "save current",
          "preset",
          "snapshot"
        )
      }
    >
      <div className="grid grid-cols-1 items-start gap-6 sm:grid-cols-2">
        <div>
          <ThemedSelect
            aria-label="Theme"
            value={settings.theme}
            options={THEMES.map((t) => ({
              value: t.value,
              label: t.label,
              group: t.group,
            }))}
            onChange={(value) => update({ theme: value })}
            className="w-full min-w-48 max-w-[18rem]"
          />
        </div>
        {settings.theme === "custom" && (
          <div>
            <p className="mb-2 text-sm font-medium text-gray-200">Save theme</p>
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="text"
                value={themeNameDraft}
                onChange={(e) => setThemeNameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    saveCurrentAsTheme();
                  }
                }}
                placeholder="Theme name"
                maxLength={64}
                aria-label="Theme name"
                className={`${INPUT} min-w-0 flex-1`}
              />
              <button
                type="button"
                onClick={saveCurrentAsTheme}
                className={PANEL_BTN}
              >
                Save
              </button>
            </div>
          </div>
        )}
      </div>
      {settings.customThemes.length > 0 && (
        <ul className="mt-4 space-y-2">
          {settings.customThemes.map((preset) => (
            <li
              key={preset.id}
              className="flex items-center justify-between gap-2 rounded-lg border border-ink-700 bg-ink-950 px-3 py-2"
            >
              <span className="truncate text-sm text-gray-200">
                {preset.name}
              </span>
              <span className="flex shrink-0 gap-1.5">
                <button
                  type="button"
                  onClick={() => applyCustomTheme(preset)}
                  className={PANEL_BTN}
                >
                  Apply
                </button>
                <button
                  type="button"
                  onClick={() => deleteCustomTheme(preset.id)}
                  className={PANEL_BTN}
                >
                  Delete
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <Collapse open={settings.theme === "custom"}>
        <div className="mt-4 max-w-xl space-y-3 rounded-lg border border-ink-700 bg-ink-950 p-4">
          <p className="text-xs text-muted">
            Pick your own accent and background. Surface colors are derived
            automatically.
          </p>
          <label className="flex items-center justify-between gap-4">
            <span className="text-sm text-gray-300">Accent</span>
            <input
              type="color"
              value={settings.customColors.accent}
              onChange={(e) =>
                update({
                  customColors: {
                    ...settings.customColors,
                    accent: e.target.value,
                  },
                })
              }
              className="h-9 w-14 cursor-pointer rounded-sm border border-ink-700 bg-transparent p-0.5"
            />
          </label>
          <label className="flex items-center justify-between gap-4">
            <span className="text-sm text-gray-300">Background</span>
            <input
              type="color"
              value={settings.customColors.background}
              onChange={(e) =>
                update({
                  customColors: {
                    ...settings.customColors,
                    background: e.target.value,
                  },
                })
              }
              className="h-9 w-14 cursor-pointer rounded-sm border border-ink-700 bg-transparent p-0.5"
            />
          </label>
          <div className="flex items-center gap-2 pt-1">
            <span
              className="h-6 flex-1 rounded-md ring-1 ring-ink-700"
              style={{
                backgroundColor: settings.customColors.background,
              }}
            />
            <span
              className="h-6 w-16 rounded-md ring-1 ring-ink-700"
              style={{
                backgroundColor: settings.customColors.accent,
              }}
            />
          </div>
        </div>
      </Collapse>
    </Section>
  );
}
