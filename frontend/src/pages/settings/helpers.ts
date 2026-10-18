import { getItem } from "../../storage";
import { TAB_STORAGE_KEY, TABS } from "./constants";
import type { SettingsTab } from "./types";

export function plural(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`;
}

export function loadTab(): SettingsTab {
  // A stored "downloads" id is renamed to "library" by a storage migration.
  const raw = getItem(TAB_STORAGE_KEY);
  if (TABS.some((t) => t.id === raw)) return raw as SettingsTab;
  return "appearance";
}

export function resolveTabParam(raw: string | null): SettingsTab | null {
  if (!raw) return null;
  if (raw === "downloads") return "library";
  if (TABS.some((t) => t.id === raw)) return raw as SettingsTab;
  return null;
}
