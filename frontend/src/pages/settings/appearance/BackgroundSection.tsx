import type {
  BackgroundEffect,
  FlowingGradientPreset,
} from "../../../hooks/useSettings";
import {
  BACKGROUND_EFFECT_OPTIONS,
  FLOWING_PRESET_OPTIONS,
} from "../../../effects";
import ThemedSelect from "../../../components/ThemedSelect";
import { PANEL_BTN } from "../constants";
import { Chip, Section, SettingRow, Toggle } from "../ui";
import { useAuth } from "../../../context/AuthContext";
import { useSettingsPage } from "../context";
import type { AppearanceState } from "../useAppearanceState";

export default function BackgroundSection({
  appearance,
}: {
  appearance: AppearanceState;
}) {
  const { q, match, settings, update } = useSettingsPage();
  // The uploaded backgrounds are shared files on the server: anyone may pick
  // one, only an administrator adds, removes or analyses them.
  const { isAdmin } = useAuth();
  const {
    bgUploading,
    uploadCustomBackground,
    lastUploadedName,
    bgLibrary,
    deleteLibraryBackground,
    paletteColors,
    paletteLoading,
    extractPalette,
    applyPaletteColor,
  } = appearance;

  return (
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
          <p className="mb-2 text-sm font-medium text-gray-200">Animation</p>
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
            className="w-48 min-w-44"
          />
          <p className="mt-2 text-xs text-muted">
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
            <p className="mb-2 text-sm font-medium text-gray-200">Animation</p>
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
              className="w-48 min-w-44"
            />
            <p className="mt-2 text-xs text-muted">
              {
                BACKGROUND_EFFECT_OPTIONS.find(
                  (o) => o.value === settings.backgroundEffect
                )?.description
              }
            </p>
          </div>

          {isAdmin && (
            <label className="block">
              <span className="mb-1 block text-xs text-muted">
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
                <p className="mt-1 text-xs text-muted">Uploading…</p>
              ) : lastUploadedName ? (
                <p className="mt-1 text-xs text-muted">
                  Uploaded: {lastUploadedName}
                </p>
              ) : null}
            </label>
          )}

          {!isAdmin && bgLibrary.length === 0 && (
            <p className="text-xs text-muted">
              No background images yet. An administrator can upload them.
            </p>
          )}

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
                          loading="lazy"
                          decoding="async"
                          width={320}
                          height={180}
                          src={item.url || `/api/backgrounds/${item.id}`}
                          alt={item.filename || "Background"}
                          className="aspect-video w-full object-cover"
                        />
                      )}
                    </button>
                    {isAdmin && (
                      <button
                        type="button"
                        aria-label="Delete background"
                        onClick={(e) => {
                          e.stopPropagation();
                          void deleteLibraryBackground(item.id);
                        }}
                        className="absolute right-1 top-1 rounded-sm bg-ink-950/80 px-1.5 py-0.5 text-[10px] text-gray-300 opacity-0 ring-1 ring-ink-700 transition-opacity group-hover:opacity-100 hover:text-red-300"
                      >
                        ✕
                      </button>
                    )}
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
                  loading="lazy"
                  decoding="async"
                  width={320}
                  height={180}
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
              <span className="tabular-nums text-muted">
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
                className="h-9 w-14 cursor-pointer rounded-sm border border-ink-700 bg-transparent p-0.5"
              />
            </label>
            <label className="block min-w-48 flex-1">
              <span className="mb-2 flex items-center justify-between text-sm text-gray-300">
                <span>Tint opacity</span>
                <span className="tabular-nums text-muted">
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

          {isAdmin && (
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
          )}
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
                className="w-48 min-w-44"
              />
              <p className="mt-2 text-xs text-muted">
                {
                  BACKGROUND_EFFECT_OPTIONS.find(
                    (o) => o.value === settings.backgroundEffect
                  )?.description
                }
              </p>
            </div>
            <div>
              <p className="mb-2 text-sm font-medium text-gray-200">Color</p>
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
                  <span className="text-sm text-gray-300">Effect color</span>
                  <input
                    type="color"
                    value={settings.backgroundEffectColor}
                    onChange={(e) =>
                      update({
                        backgroundEffectColor: e.target.value,
                      })
                    }
                    className="h-9 w-14 cursor-pointer rounded-sm border border-ink-700 bg-transparent p-0.5"
                  />
                </label>
              )}
            </div>
          </div>

          <label className="block">
            <span className="mb-2 flex items-center justify-between text-sm text-gray-300">
              <span>Intensity</span>
              <span className="tabular-nums text-muted">
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
              <span className="tabular-nums text-muted">
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
              <span className="tabular-nums text-muted">
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
            description="Stop the animation on the watch page and while a video plays, to save GPU. Fit-window and fullscreen playback always pause it."
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
  );
}
