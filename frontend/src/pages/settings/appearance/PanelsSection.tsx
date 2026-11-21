import Collapse from "../../../components/Collapse";
import { Section, SettingRow, Toggle } from "../ui";
import { useSettingsPage } from "../context";

export default function PanelsSection() {
  const { q, match, settings, update } = useSettingsPage();

  return (
    <Section
      anchor="panels"
      title="Panels"
      hidden={
        !!q &&
        !match(
          "translucent panels",
          "panel transparency",
          "panels",
          "blur",
          "frost",
          "glass",
          "tint",
          "legibility"
        )
      }
    >
      <div className="space-y-3">
        <label className="block">
          <span className="mb-2 flex items-center justify-between text-sm text-gray-300">
            <span>Transparency</span>
            <span className="tabular-nums text-muted">
              {Math.round(settings.translucentPanelStrength * 100)}%
            </span>
          </span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            aria-label="Panel transparency"
            value={settings.translucentPanelStrength}
            onChange={(e) =>
              update({
                translucentPanelStrength: Number(e.target.value),
              })
            }
            className="accent-scrubber w-full"
          />
        </label>
        <label className="block">
          <span className="mb-2 flex items-center justify-between text-sm text-gray-300">
            <span>Blur</span>
            <span className="tabular-nums text-muted">
              {Math.round(settings.translucentPanelBlur * 100)}%
            </span>
          </span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            aria-label="Panel blur"
            value={settings.translucentPanelBlur}
            onChange={(e) =>
              update({
                translucentPanelBlur: Number(e.target.value),
              })
            }
            className="accent-scrubber w-full"
          />
        </label>
        <SettingRow
          title="Tint"
          description="Mix a color into cards and chrome. Turn off to use the theme fill only."
          control={
            <Toggle
              checked={settings.translucentPanelTintEnabled}
              onChange={() =>
                update({
                  translucentPanelTintEnabled:
                    !settings.translucentPanelTintEnabled,
                })
              }
            />
          }
        />
        <Collapse open={settings.translucentPanelTintEnabled}>
          <div className="flex flex-wrap items-end gap-4 pt-1 pb-3">
            <label className="flex items-center gap-3">
              <span className="text-sm text-gray-300">Color</span>
              <input
                type="color"
                aria-label="Panel tint color"
                value={settings.translucentPanelTint}
                onChange={(e) =>
                  update({ translucentPanelTint: e.target.value })
                }
                className="h-9 w-14 cursor-pointer rounded-sm border border-ink-700 bg-transparent p-0.5"
              />
            </label>
            <label className="block min-w-48 flex-1">
              <span className="mb-2 flex items-center justify-between text-sm text-gray-300">
                <span>Strength</span>
                <span className="tabular-nums text-muted">
                  {Math.round(settings.translucentPanelTintStrength * 100)}%
                </span>
              </span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                aria-label="Panel tint strength"
                value={settings.translucentPanelTintStrength}
                onChange={(e) =>
                  update({
                    translucentPanelTintStrength: Number(e.target.value),
                  })
                }
                className="accent-scrubber w-full"
              />
            </label>
          </div>
        </Collapse>
        <SettingRow
          title="Improve legibility"
          description="Raise opacity on panels that need readable text."
          control={
            <Toggle
              checked={settings.translucentPanelLegibility}
              onChange={() =>
                update({
                  translucentPanelLegibility:
                    !settings.translucentPanelLegibility,
                })
              }
            />
          }
        />
      </div>
    </Section>
  );
}
