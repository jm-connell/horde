import { DEFAULTS, SERVER_UI_KEYS } from "./defaults";
import { migratePanelTranslucency } from "./migrations";
import type { Settings } from "./types";

/**
 * `ui` keys the server owns (the download codec, the H.264 copy size): they set
 * what the server does for everyone, so only an administrator may change them.
 * Mirrors `SERVER_UI_KEYS` in backend/app/services/user_settings.py.
 */
export const SERVER_OWNED_UI_KEYS: readonly string[] = [
  "download_video_codec",
  "compat_copy_resolution",
];

/** `ui` without the server-owned keys: what a member's client may send. */
export function withoutServerOwnedUi(
  ui: Record<string, unknown>
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(ui).filter(([key]) => !SERVER_OWNED_UI_KEYS.includes(key))
  );
}

function camelToSnake(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

function snakeToCamel(key: string): string {
  return key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

export function settingsToServerUi(
  settings: Settings
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of SERVER_UI_KEYS) {
    const val = settings[key];
    out[camelToSnake(key)] = val;
  }
  return out;
}

export function serverUiToSettingsPatch(
  ui: Record<string, unknown>
): Partial<Settings> {
  const patch: Record<string, unknown> = {};
  for (const [snake, val] of Object.entries(ui)) {
    const camel = snakeToCamel(snake);
    if (camel in DEFAULTS || SERVER_UI_KEYS.includes(camel as keyof Settings)) {
      patch[camel] = val;
    }
  }
  // custom_colors arrives as object
  if (ui.custom_colors && typeof ui.custom_colors === "object") {
    patch.customColors = ui.custom_colors;
  }

  // Old blobs stored a toggle instead of an independent blur slider.
  if (
    !Object.prototype.hasOwnProperty.call(ui, "translucent_panel_blur") &&
    Object.prototype.hasOwnProperty.call(ui, "translucent_panels")
  ) {
    const migrated = migratePanelTranslucency({
      translucentPanels: ui.translucent_panels,
      translucentPanelStrength:
        patch.translucentPanelStrength ?? ui.translucent_panel_strength,
    });
    patch.translucentPanelStrength = migrated.translucentPanelStrength;
    patch.translucentPanelBlur = migrated.translucentPanelBlur;
  }

  return patch as Partial<Settings>;
}

/** The server `ui` keys whose value differs between two settings objects. */
export function changedServerUi(
  before: Settings,
  after: Settings
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of SERVER_UI_KEYS) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      out[camelToSnake(key)] = after[key];
    }
  }
  return out;
}
