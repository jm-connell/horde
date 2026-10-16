import { DEFAULTS, SERVER_UI_KEYS } from "./defaults";
import { migratePanelTranslucency } from "./migrations";
import type { Settings } from "./types";

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
