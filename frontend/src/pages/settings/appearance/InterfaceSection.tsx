import {
  LOADING_STYLE_OPTIONS,
  LOADING_STYLE_SEARCH_KEYWORDS,
} from "../../../loadingStyles";
import Collapse from "../../../components/Collapse";
import LiquidNav from "../../../components/LiquidNav";
import { LoadingMark } from "../../../components/LoadingIndicator";
import { HOVER_MOTION_OPTIONS, NAV_INDICATOR_OPTIONS } from "../constants";
import { Chip, Section, SettingRow, Toggle } from "../ui";
import { useSettingsPage } from "../context";
import type { AppearanceState } from "../useAppearanceState";

export default function InterfaceSection({
  appearance,
}: {
  appearance: AppearanceState;
}) {
  const { q, match, settings, update } = useSettingsPage();
  const { navPreview, setNavPreview } = appearance;
  const selectedLoading = LOADING_STYLE_OPTIONS.find(
    (o) => o.value === settings.loadingStyle
  );

  return (
    <Section
      title="Interface"
      hidden={
        !!q &&
        !match(
          "interface motion",
          "ui",
          "navigation indicator",
          "nav",
          "liquid",
          "jelly",
          "underline",
          "fade",
          "glow",
          "lift",
          "hover motion",
          "translucent panels",
          "panel transparency",
          "panels",
          "blur",
          "frost",
          "glass",
          "tint",
          "legibility",
          "loading animation",
          LOADING_STYLE_SEARCH_KEYWORDS
        )
      }
    >
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
          <div
            className={`min-w-0 flex-1 ${
              match(
                "navigation indicator",
                "nav",
                "liquid",
                "jelly",
                "underline",
                "fade"
              )
                ? ""
                : q
                  ? "hidden"
                  : ""
            }`}
          >
            <p className="mb-2 text-sm font-medium text-gray-200">
              Navigation indicator
            </p>
            <div className="flex flex-wrap gap-2">
              {NAV_INDICATOR_OPTIONS.map((opt) => (
                <Chip
                  key={opt.value}
                  active={settings.navIndicator === opt.value}
                  onClick={() => update({ navIndicator: opt.value })}
                >
                  {opt.label}
                </Chip>
              ))}
            </div>
            <p className="mt-2 text-xs text-muted">
              {
                NAV_INDICATOR_OPTIONS.find(
                  (o) => o.value === settings.navIndicator
                )?.description
              }
            </p>
            <LiquidNav
              className="ui-panel mt-3 inline-flex w-fit gap-1 rounded-xl bg-ink-950 p-1 ring-1 ring-ink-700"
              pillClassName="bg-ink-800"
              dependency={navPreview}
            >
              {(
                [
                  { id: "home", label: "Home" },
                  { id: "library", label: "Library" },
                  { id: "settings", label: "Settings" },
                ] as const
              ).map((item) => (
                <button
                  key={item.id}
                  type="button"
                  data-liquid-active={
                    navPreview === item.id ? "true" : undefined
                  }
                  onClick={() => setNavPreview(item.id)}
                  className={`ui-interactive relative z-10 shrink-0 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                    navPreview === item.id
                      ? settings.navIndicator !== "none"
                        ? "text-gray-100"
                        : "bg-ink-800 text-gray-100"
                      : "text-gray-400 hover:text-gray-200"
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </LiquidNav>
          </div>

          <div
            className={`min-w-0 flex-1 ${
              match("hover motion", "cards", "controls", "glow", "lift")
                ? ""
                : q
                  ? "hidden"
                  : ""
            }`}
          >
            <p className="mb-2 text-sm font-medium text-gray-200">
              Hover motion
            </p>
            <div className="flex flex-wrap gap-2">
              {HOVER_MOTION_OPTIONS.map((opt) => (
                <Chip
                  key={opt.value}
                  active={settings.hoverMotion === opt.value}
                  onClick={() => update({ hoverMotion: opt.value })}
                >
                  {opt.label}
                </Chip>
              ))}
            </div>
            <p className="mt-2 text-xs text-muted">
              {
                HOVER_MOTION_OPTIONS.find(
                  (o) => o.value === settings.hoverMotion
                )?.description
              }
            </p>
          </div>
        </div>

        <div
          className={
            match(
              "translucent panels",
              "panel transparency",
              "panels",
              "blur",
              "frost",
              "glass",
              "tint",
              "legibility"
            )
              ? undefined
              : q
                ? "hidden"
                : undefined
          }
        >
          <p className="mb-3 text-sm font-medium text-gray-200">Panels</p>
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
        </div>

        <div
          className={
            match("loading animation", LOADING_STYLE_SEARCH_KEYWORDS)
              ? undefined
              : q
                ? "hidden"
                : undefined
          }
        >
          <span className="mb-2 block text-sm font-medium text-gray-200">
            Loading animation
          </span>
          <div
            className="flex flex-wrap gap-2"
            role="group"
            aria-label="Loading animation"
          >
            {LOADING_STYLE_OPTIONS.map((opt) => (
              <Chip
                key={opt.value}
                active={settings.loadingStyle === opt.value}
                onClick={() => update({ loadingStyle: opt.value })}
                title={`${opt.label} — ${opt.description}`}
                aria-label={opt.label}
                className="flex h-20 w-20 shrink-0 items-center justify-center overflow-visible px-1.5! py-1.5!"
              >
                <LoadingMark style={opt.value} compact />
              </Chip>
            ))}
          </div>
          <p className="mt-2 text-xs text-muted">
            {selectedLoading
              ? `${selectedLoading.label} — ${selectedLoading.description}`
              : null}
          </p>
        </div>
      </div>
    </Section>
  );
}
