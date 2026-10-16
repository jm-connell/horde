import { getJson, removeItem, setJson } from "../../storage";
import { DEFAULTS, STORAGE_KEY } from "./defaults";
import { normalizeSettings } from "./migrations";
import type { Settings } from "./types";

export function loadSettings(): Settings {
  // The pre-settings-blob preview-mute flag is folded in by a storage migration.
  const parsed = getJson<Partial<Settings> & { liquidNav?: boolean }>(
    STORAGE_KEY,
    (v): v is Partial<Settings> =>
      typeof v === "object" && v !== null && !Array.isArray(v),
    {}
  );
  try {
    return normalizeSettings(parsed);
  } catch {
    return DEFAULTS;
  }
}

export const SETTINGS_CHANGED_EVENT = "horde:settings-changed";

/** The user the cached preferences in this browser belong to. */
export const PENDING_KEY = "horde.settings-pending";
export const OWNER_KEY = "horde.settings-owner";

/** Forget this browser's cached preferences (on sign-in/out, so users never see each other's). */
export function clearLocalSettings(): void {
  removeItem(STORAGE_KEY);
  removeItem(OWNER_KEY);
  removeItem(PENDING_KEY);
}

export function persistLocal(settings: Settings): void {
  setJson(STORAGE_KEY, settings);
  window.dispatchEvent(new Event(SETTINGS_CHANGED_EVENT));
}
