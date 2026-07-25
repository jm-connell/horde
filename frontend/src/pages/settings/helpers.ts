import { TAB_STORAGE_KEY, TABS, UPDATE_DISMISS_KEY } from "./constants";
import type { SettingsTab } from "./types";

export function plural(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`;
}

export function loadDismissedUpdateSha(): string | null {
  try {
    return localStorage.getItem(UPDATE_DISMISS_KEY);
  } catch {
    return null;
  }
}

export function saveDismissedUpdateSha(sha: string) {
  try {
    localStorage.setItem(UPDATE_DISMISS_KEY, sha);
  } catch {
    /* ignore */
  }
}

export function loadTab(): SettingsTab {
  try {
    const raw = localStorage.getItem(TAB_STORAGE_KEY);
    if (raw === "downloads") return "library";
    if (TABS.some((t) => t.id === raw)) return raw as SettingsTab;
  } catch {
    /* ignore */
  }
  return "appearance";
}

export function resolveTabParam(raw: string | null): SettingsTab | null {
  if (!raw) return null;
  if (raw === "downloads") return "library";
  if (TABS.some((t) => t.id === raw)) return raw as SettingsTab;
  return null;
}
