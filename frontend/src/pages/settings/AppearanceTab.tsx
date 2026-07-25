import { api } from "../../api";
import { loadSettings } from "../../hooks/useSettings";
import type { BackgroundEffect, FlowingGradientPreset, UiFont } from "../../hooks/useSettings";
import { fontSelectOptions, labelFromFilename } from "../../fonts";
import { BACKGROUND_EFFECT_OPTIONS, FLOWING_PRESET_OPTIONS } from "../../effects";
import LiquidNav from "../../components/LiquidNav";
import ThemedSelect from "../../components/ThemedSelect";
import Collapse from "../../components/Collapse";
import {
  FONT_SIZE_OPTIONS,
  HOVER_MOTION_OPTIONS,
  INPUT,
  NAV_INDICATOR_OPTIONS,
  PANEL_BTN,
  THEMES,
} from "./constants";
import { Chip, Section, SettingRow, Toggle } from "./ui";
import { useSettingsPage } from "./context";

export default function AppearanceTab() {
  const {
    q,
    match,
    settings,
    update,
    showToast,
    themeNameDraft,
    setThemeNameDraft,
    saveCurrentAsTheme,
    applyCustomTheme,
    deleteCustomTheme,
    customFontDraft,
    setCustomFontDraft,
    addCustomFontFromUrl,
    bgUploading,
    uploadCustomBackground,
    lastUploadedName,
    bgLibrary,
    deleteLibraryBackground,
    paletteColors,
    paletteLoading,
    extractPalette,
    applyPaletteColor,
    navPreview,
    setNavPreview,
  } = useSettingsPage();

  return (
    <>
      <Section
        first
        title="Theme"
        description="Choose a color palette. Snapshot the current Appearance choices — colors, background, font, and UI — then reapply later."
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
            <p className="mb-2 text-sm font-medium text-gray-200">Palette</p>
            <ThemedSelect
              aria-label="Theme"
              value={settings.theme}
              options={THEMES.map((t) => ({
                value: t.value,
                label: t.label,
              }))}
              onChange={(value) => update({ theme: value })}
              className="w-full min-w-[12rem] max-w-[18rem]"
            />
          </div>
          <div>
            <p className="mb-2 text-sm font-medium text-gray-200">
              Save theme
            </p>
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
            <p className="text-xs text-gray-500">
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
                className="h-9 w-14 cursor-pointer rounded border border-ink-700 bg-transparent p-0.5"
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
                className="h-9 w-14 cursor-pointer rounded border border-ink-700 bg-transparent p-0.5"
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

      <Section
        title="Font"
        description="App typeface and size. Inter (default) keeps the current stack."
        hidden={
          !!q &&
          !match(
            "font",
            "typeface",
            "typography",
            "google fonts",
            "jetbrains",
            "roboto",
            "ubuntu",
            "oxanium",
            "source sans",
            "font size",
            "text size"
          )
        }
      >
        <div className="grid grid-cols-1 items-start gap-6 sm:grid-cols-2">
          <div
            className={
              match(
                "font",
                "typeface",
                "typography",
                "google fonts",
                "jetbrains",
                "roboto",
                "ubuntu",
                "oxanium",
                "source sans",
                "electrolize"
              )
                ? undefined
                : q
                  ? "hidden"
                  : undefined
            }
          >
            <p className="mb-2 text-sm font-medium text-gray-200">
              Typeface
            </p>
            <ThemedSelect
              aria-label="Font"
              value={settings.uiFont}
              options={fontSelectOptions(settings.customFonts)}
              onChange={(value: UiFont) => update({ uiFont: value })}
              className="w-full min-w-[12rem] max-w-[18rem]"
            />
            <p className="mt-2 text-sm text-gray-400">
              The quick brown fox jumps over the lazy dog 0123456789
            </p>
          </div>
          <div
            className={
              match("font size", "text size", "small", "medium", "large", "xl")
                ? undefined
                : q
                  ? "hidden"
                  : undefined
            }
          >
            <p className="mb-2 text-sm font-medium text-gray-200">
              Font size
            </p>
            <p className="mb-3 text-xs text-gray-500">
              Scales text across the app without extreme zoom steps.
            </p>
            <div data-font-size-control className="flex flex-wrap gap-2">
              {FONT_SIZE_OPTIONS.map((opt) => (
                <Chip
                  key={opt.value}
                  active={settings.fontSize === opt.value}
                  onPointerDown={() => update({ fontSize: opt.value })}
                  className="!py-1.5"
                >
                  {opt.label}
                </Chip>
              ))}
            </div>
          </div>
        </div>

        {settings.uiFont === "custom" && (
          <div className="mt-4 w-full max-w-2xl space-y-3 rounded-lg border border-ink-700 bg-ink-950 p-4">
            <label className="block space-y-1.5">
              <span className="text-sm text-gray-300">
                Google Fonts URL or family name
              </span>
              <div className="flex flex-wrap gap-2">
                <input
                  type="text"
                  value={customFontDraft}
                  onChange={(e) => setCustomFontDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addCustomFontFromUrl(customFontDraft);
                    }
                  }}
                  placeholder="e.g. Nunito or fonts.googleapis.com/css2?family=…"
                  className={`${INPUT} flex-1`}
                />
                <button
                  type="button"
                  className={PANEL_BTN}
                  onClick={() => addCustomFontFromUrl(customFontDraft)}
                >
                  Add
                </button>
              </div>
            </label>
            <div className="space-y-1.5">
              <span className="block text-sm text-gray-300">
                Or upload a font file
              </span>
              <input
                type="file"
                accept=".woff2,.woff,.ttf,.otf,font/woff2,font/woff,font/ttf,font/otf"
                className="block w-full max-w-md text-sm text-gray-400 file:mr-3 file:rounded-lg file:border-0 file:bg-ink-800 file:px-3 file:py-1.5 file:text-sm file:text-gray-200"
                onChange={(e) => {
                  const file = e.target.files?.[0] ?? null;
                  e.target.value = "";
                  if (!file) return;
                  void (async () => {
                    try {
                      const result = await api.uploadFont(file);
                      const name = labelFromFilename(
                        result.filename || file.name
                      );
                      const current = loadSettings();
                      update({
                        customFonts: [
                          ...current.customFonts,
                          {
                            id: result.id,
                            name,
                            source: "file",
                          },
                        ],
                        uiFont: result.id,
                      });
                      showToast(`Saved “${name}”`);
                    } catch {
                      showToast("Font upload failed");
                    }
                  })();
                }}
              />
              <p className="text-xs text-gray-500">
                Saved fonts are added to the dropdown permanently and stored
                with your Horde data.
              </p>
            </div>
          </div>
        )}

        {settings.customFonts.some((f) => f.id === settings.uiFont) && (
          <button
            type="button"
            className={`${PANEL_BTN} mt-4`}
            onClick={() => {
              const id = settings.uiFont;
              const entry = settings.customFonts.find((f) => f.id === id);
              const next = loadSettings().customFonts.filter(
                (f) => f.id !== id
              );
              if (entry?.source === "file") {
                void api.deleteFont(id).catch(() => undefined);
              }
              update({
                customFonts: next,
                uiFont: "default",
              });
              showToast("Removed custom font");
            }}
          >
            Remove from dropdown
          </button>
        )}
      </Section>

      <Section
        title="Background"
        description="Atmospheric effects and custom images behind the UI."
        hidden={
          !!q &&
          !match(
            "background",
            "animation",
            "atmospheric",
            "effects",
            "intensity",
            "speed",
            "size",
            "color",
            "pause while watching",
            "custom image",
            "upload",
            "blur",
            "tint",
            "palette",
            "flowing",
            "rgb",
            "wave",
            "cool",
            "warm",
            "mono"
          )
        }
      >
        {settings.backgroundEffect === "none" ? (
          <div>
            <p className="mb-2 text-sm font-medium text-gray-200">
              Animation
            </p>
            <ThemedSelect
              aria-label="Background animation"
              value={settings.backgroundEffect}
              options={BACKGROUND_EFFECT_OPTIONS.map((o) => ({
                value: o.value,
                label: o.label,
              }))}
              onChange={(value) =>
                update({ backgroundEffect: value as BackgroundEffect })
              }
              className="w-[12rem] min-w-[11rem]"
            />
            <p className="mt-2 text-xs text-gray-500">
              {
                BACKGROUND_EFFECT_OPTIONS.find(
                  (o) => o.value === settings.backgroundEffect
                )?.description
              }
            </p>
          </div>
        ) : settings.backgroundEffect === "custom-image" ? (
          <div className="space-y-4">
            <div>
              <p className="mb-2 text-sm font-medium text-gray-200">
                Animation
              </p>
              <ThemedSelect
                aria-label="Background animation"
                value={settings.backgroundEffect}
                options={BACKGROUND_EFFECT_OPTIONS.map((o) => ({
                  value: o.value,
                  label: o.label,
                }))}
                onChange={(value) =>
                  update({ backgroundEffect: value as BackgroundEffect })
                }
                className="w-[12rem] min-w-[11rem]"
              />
              <p className="mt-2 text-xs text-gray-500">
                {
                  BACKGROUND_EFFECT_OPTIONS.find(
                    (o) => o.value === settings.backgroundEffect
                  )?.description
                }
              </p>
            </div>

            <label className="block">
              <span className="mb-1 block text-xs text-gray-500">
                Image or GIF / WebM
              </span>
              <input
                type="file"
                accept=".jpg,.jpeg,.png,.webp,.gif,.webm,image/*,video/webm"
                disabled={bgUploading}
                onChange={(e) => {
                  const file = e.target.files?.[0] ?? null;
                  e.target.value = "";
                  void uploadCustomBackground(file);
                }}
                className="block w-full max-w-md text-sm text-gray-400 file:mr-3 file:rounded-lg file:border file:border-ink-700 file:bg-ink-900 file:px-3 file:py-1.5 file:text-sm file:text-gray-200 hover:file:border-accent"
              />
              {bgUploading ? (
                <p className="mt-1 text-xs text-gray-500">Uploading…</p>
              ) : lastUploadedName ? (
                <p className="mt-1 text-xs text-gray-500">
                  Uploaded: {lastUploadedName}
                </p>
              ) : null}
            </label>

            {bgLibrary.length > 0 && (
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                {bgLibrary.map((item) => {
                  const selected = settings.customBackgroundId === item.id;
                  return (
                    <div
                      key={item.id}
                      className={`group relative overflow-hidden rounded-lg border bg-ink-950 ${
                        selected
                          ? "border-accent ring-2 ring-accent"
                          : "border-ink-700"
                      }`}
                    >
                      <button
                        type="button"
                        title={item.filename || item.id}
                        onClick={() =>
                          update({
                            backgroundEffect: "custom-image",
                            customBackgroundId: item.id,
                            customBackgroundMime: item.mime,
                          })
                        }
                        className="block w-full"
                      >
                        {(item.mime || "").startsWith("video/") ? (
                          <video
                            src={item.url || `/api/backgrounds/${item.id}`}
                            className="aspect-video w-full object-cover"
                            muted
                            loop
                            playsInline
                          />
                        ) : (
                          <img
                            src={item.url || `/api/backgrounds/${item.id}`}
                            alt={item.filename || "Background"}
                            className="aspect-video w-full object-cover"
                          />
                        )}
                      </button>
                      <button
                        type="button"
                        aria-label="Delete background"
                        onClick={(e) => {
                          e.stopPropagation();
                          void deleteLibraryBackground(item.id);
                        }}
                        className="absolute right-1 top-1 rounded bg-ink-950/80 px-1.5 py-0.5 text-[10px] text-gray-300 opacity-0 ring-1 ring-ink-700 transition-opacity group-hover:opacity-100 hover:text-red-300"
                      >
                        ✕
                      </button>
                    </div>
                  );
                })}
              </div>
            )}

            {settings.customBackgroundId && (
              <div className="overflow-hidden rounded-lg border border-ink-700 bg-ink-950">
                {(settings.customBackgroundMime || "").startsWith("video/") ? (
                  <video
                    src={`/api/backgrounds/${settings.customBackgroundId}`}
                    className="max-h-40 w-full object-cover"
                    muted
                    loop
                    autoPlay
                    playsInline
                  />
                ) : (
                  <img
                    src={`/api/backgrounds/${settings.customBackgroundId}`}
                    alt="Custom background preview"
                    className="max-h-40 w-full object-cover"
                  />
                )}
              </div>
            )}

            <label className="block">
              <span className="mb-2 flex items-center justify-between text-sm text-gray-300">
                <span>Blur</span>
                <span className="tabular-nums text-gray-500">
                  {Math.round(settings.customBackgroundBlur)}px
                </span>
              </span>
              <input
                type="range"
                min={0}
                max={40}
                step={1}
                value={settings.customBackgroundBlur}
                onChange={(e) =>
                  update({
                    customBackgroundBlur: Number(e.target.value),
                  })
                }
                className="accent-scrubber w-full"
              />
            </label>

            <div className="flex flex-wrap items-end gap-4">
              <label className="flex items-center gap-3">
                <span className="text-sm text-gray-300">Tint</span>
                <input
                  type="color"
                  value={settings.customBackgroundTint}
                  onChange={(e) =>
                    update({ customBackgroundTint: e.target.value })
                  }
                  className="h-9 w-14 cursor-pointer rounded border border-ink-700 bg-transparent p-0.5"
                />
              </label>
              <label className="block min-w-[12rem] flex-1">
                <span className="mb-2 flex items-center justify-between text-sm text-gray-300">
                  <span>Tint opacity</span>
                  <span className="tabular-nums text-gray-500">
                    {Math.round(settings.customBackgroundTintOpacity * 100)}%
                  </span>
                </span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={settings.customBackgroundTintOpacity}
                  onChange={(e) =>
                    update({
                      customBackgroundTintOpacity: Number(e.target.value),
                    })
                  }
                  className="accent-scrubber w-full"
                />
              </label>
            </div>

            <div>
              <button
                type="button"
                disabled={!settings.customBackgroundId || paletteLoading}
                onClick={() => void extractPalette()}
                className={PANEL_BTN}
              >
                {paletteLoading ? "Extracting…" : "Extract palette"}
              </button>
              {paletteColors.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {paletteColors.map((c) => (
                    <button
                      key={c}
                      type="button"
                      title={`Use ${c} as accent`}
                      onClick={() => applyPaletteColor(c)}
                      className="ui-interactive h-8 w-8 rounded-full ring-1 ring-ink-700 hover:ring-accent"
                      style={{ backgroundColor: c }}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-1 items-start gap-6 sm:grid-cols-2">
              <div>
                <p className="mb-2 text-sm font-medium text-gray-200">
                  Animation
                </p>
                <ThemedSelect
                  aria-label="Background animation"
                  value={settings.backgroundEffect}
                  options={BACKGROUND_EFFECT_OPTIONS.map((o) => ({
                    value: o.value,
                    label: o.label,
                  }))}
                  onChange={(value) =>
                    update({
                      backgroundEffect: value as BackgroundEffect,
                    })
                  }
                  className="w-[12rem] min-w-[11rem]"
                />
                <p className="mt-2 text-xs text-gray-500">
                  {
                    BACKGROUND_EFFECT_OPTIONS.find(
                      (o) => o.value === settings.backgroundEffect
                    )?.description
                  }
                </p>
              </div>
              <div>
                <p className="mb-2 text-sm font-medium text-gray-200">
                  Color
                </p>
                <div className="mb-3 flex flex-wrap gap-2">
                  {(
                    [
                      { value: "accent", label: "Match theme accent" },
                      { value: "custom", label: "Custom" },
                    ] as const
                  ).map((opt) => (
                    <Chip
                      key={opt.value}
                      active={settings.backgroundEffectColorMode === opt.value}
                      onClick={() =>
                        update({ backgroundEffectColorMode: opt.value })
                      }
                    >
                      {opt.label}
                    </Chip>
                  ))}
                </div>
                {settings.backgroundEffectColorMode === "custom" && (
                  <label className="flex items-center justify-between gap-4 rounded-lg border border-ink-700 bg-ink-950 px-3 py-2">
                    <span className="text-sm text-gray-300">
                      Effect color
                    </span>
                    <input
                      type="color"
                      value={settings.backgroundEffectColor}
                      onChange={(e) =>
                        update({
                          backgroundEffectColor: e.target.value,
                        })
                      }
                      className="h-9 w-14 cursor-pointer rounded border border-ink-700 bg-transparent p-0.5"
                    />
                  </label>
                )}
              </div>
            </div>

            <label className="block">
              <span className="mb-2 flex items-center justify-between text-sm text-gray-300">
                <span>Intensity</span>
                <span className="tabular-nums text-gray-500">
                  {Math.round(settings.backgroundOpacity * 100)}%
                </span>
              </span>
              <input
                type="range"
                min={0.1}
                max={1}
                step={0.05}
                value={settings.backgroundOpacity}
                onChange={(e) =>
                  update({ backgroundOpacity: Number(e.target.value) })
                }
                className="accent-scrubber w-full"
              />
            </label>

            <label className="block">
              <span className="mb-2 flex items-center justify-between text-sm text-gray-300">
                <span>Speed</span>
                <span className="tabular-nums text-gray-500">
                  {settings.backgroundEffectSpeed.toFixed(2)}x
                </span>
              </span>
              <input
                type="range"
                min={0.25}
                max={3}
                step={0.05}
                value={settings.backgroundEffectSpeed}
                onChange={(e) =>
                  update({
                    backgroundEffectSpeed: Number(e.target.value),
                  })
                }
                className="accent-scrubber w-full"
              />
            </label>

            <label className="block">
              <span className="mb-2 flex items-center justify-between text-sm text-gray-300">
                <span>Size</span>
                <span className="tabular-nums text-gray-500">
                  {settings.backgroundEffectSize.toFixed(2)}x
                </span>
              </span>
              <input
                type="range"
                min={0.5}
                max={2}
                step={0.05}
                value={settings.backgroundEffectSize}
                onChange={(e) =>
                  update({
                    backgroundEffectSize: Number(e.target.value),
                  })
                }
                className="accent-scrubber w-full"
              />
            </label>

            {settings.backgroundEffect === "flowing-gradient" && (
              <div>
                <p className="mb-2 text-sm text-gray-300">Flowing palette</p>
                <div className="flex flex-wrap gap-2">
                  {FLOWING_PRESET_OPTIONS.map((opt) => (
                    <Chip
                      key={opt.value}
                      active={settings.flowingGradientPreset === opt.value}
                      onClick={() =>
                        update({
                          flowingGradientPreset:
                            opt.value as FlowingGradientPreset,
                        })
                      }
                    >
                      {opt.label}
                    </Chip>
                  ))}
                </div>
              </div>
            )}

            <SettingRow
              title="Pause while watching"
              description="Stop the animation on the watch page to save GPU."
              control={
                <Toggle
                  checked={settings.pauseBackgroundWhileWatching}
                  onChange={() =>
                    update({
                      pauseBackgroundWhileWatching:
                        !settings.pauseBackgroundWhileWatching,
                    })
                  }
                />
              }
            />
          </div>
        )}
      </Section>

      <Section
        title="Interface"
        description="Motion, panels, and loading chrome. Reduced automatically when the system prefers less motion."
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
            "legibility",
            "loading animation",
            "dots",
            "spinner",
            "bar"
          )
        }
      >
        <div className="space-y-5">
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
              <p className="mt-2 text-xs text-gray-500">
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
              <p className="mt-2 text-xs text-gray-500">
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
              match("translucent panels", "panel transparency", "legibility")
                ? undefined
                : q
                  ? "hidden"
                  : undefined
            }
          >
            <SettingRow
              title="Translucent panels"
              description="Let background effects show through cards and chrome."
              control={
                <Toggle
                  checked={settings.translucentPanels}
                  onChange={() =>
                    update({
                      translucentPanels: !settings.translucentPanels,
                    })
                  }
                />
              }
            />
            <Collapse open={settings.translucentPanels}>
              <div className="mt-3 space-y-3">
                <label className="block">
                  <span className="mb-2 flex items-center justify-between text-sm text-gray-300">
                    <span>Transparency</span>
                    <span className="tabular-nums text-gray-500">
                      {Math.round(settings.translucentPanelStrength * 100)}%
                    </span>
                  </span>
                  <input
                    type="range"
                    min={0.15}
                    max={1}
                    step={0.05}
                    value={settings.translucentPanelStrength}
                    onChange={(e) =>
                      update({
                        translucentPanelStrength: Number(e.target.value),
                      })
                    }
                    className="accent-scrubber w-full"
                  />
                </label>
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
            </Collapse>
          </div>

          <div
            className={
              match("loading animation", "dots", "spinner", "bar")
                ? undefined
                : q
                  ? "hidden"
                  : undefined
            }
          >
            <span className="mb-2 block text-sm font-medium text-gray-200">
              Loading animation
            </span>
            <div className="flex flex-wrap gap-2">
              {(
                [
                  { value: "dots", label: "Dots" },
                  { value: "spinner", label: "Spinner" },
                  { value: "bar", label: "Bar" },
                ] as const
              ).map((opt) => (
                <Chip
                  key={opt.value}
                  active={settings.loadingStyle === opt.value}
                  onClick={() => update({ loadingStyle: opt.value })}
                  className="!py-1.5"
                >
                  {opt.label}
                </Chip>
              ))}
            </div>
          </div>
        </div>
      </Section>
    </>
  );
}
