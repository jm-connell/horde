/** Rebindable keyboard shortcuts: the actions, their default keys, and the user's overrides. */

export type HotkeyAction =
  | "focusSearch"
  | "playPause"
  | "seekBack"
  | "seekForward"
  | "volumeUp"
  | "volumeDown"
  | "speedDown"
  | "speedUp"
  | "nextChapter"
  | "captions"
  | "theater"
  | "fitWindow";

export interface HotkeyDef {
  id: HotkeyAction;
  label: string;
  group: "General" | "Player";
  /** `KeyboardEvent.key` values; letters are stored lower case. */
  defaults: string[];
}

export const HOTKEYS: HotkeyDef[] = [
  {
    id: "focusSearch",
    label: "Focus search",
    group: "General",
    defaults: ["/"],
  },
  {
    id: "playPause",
    label: "Play / pause",
    group: "Player",
    defaults: [" ", "k"],
  },
  {
    id: "seekBack",
    label: "Back 5 seconds",
    group: "Player",
    defaults: ["ArrowLeft"],
  },
  {
    id: "seekForward",
    label: "Forward 5 seconds",
    group: "Player",
    defaults: ["ArrowRight"],
  },
  {
    id: "volumeUp",
    label: "Volume up",
    group: "Player",
    defaults: ["ArrowUp"],
  },
  {
    id: "volumeDown",
    label: "Volume down",
    group: "Player",
    defaults: ["ArrowDown"],
  },
  { id: "speedDown", label: "Slower", group: "Player", defaults: [",", "<"] },
  { id: "speedUp", label: "Faster", group: "Player", defaults: [".", ">"] },
  {
    id: "nextChapter",
    label: "Next chapter",
    group: "Player",
    defaults: ["n"],
  },
  { id: "captions", label: "Captions", group: "Player", defaults: ["c"] },
  { id: "theater", label: "Theater mode", group: "Player", defaults: ["t"] },
  { id: "fitWindow", label: "Fit to window", group: "Player", defaults: ["f"] },
];

/** Only the actions the user rebound; the rest keep their defaults. */
export type HotkeyOverrides = Partial<Record<HotkeyAction, string[]>>;
export type HotkeyMap = Record<HotkeyAction, string[]>;

/** Keys that keep their own meaning and cannot be bound. */
const RESERVED = new Set([
  "Escape",
  "Tab",
  "Enter",
  "Shift",
  "Control",
  "Alt",
  "Meta",
  "CapsLock",
]);

const ACTION_IDS = new Set<string>(HOTKEYS.map((h) => h.id));

/** `K` and `k` are the same shortcut. */
export function normalizeKey(key: string): string {
  return key.length === 1 ? key.toLowerCase() : key;
}

export function isBindableKey(key: string): boolean {
  return (
    key !== "" && key !== "Dead" && key !== "Unidentified" && !RESERVED.has(key)
  );
}

export function resolveHotkeys(overrides: HotkeyOverrides): HotkeyMap {
  const map = {} as HotkeyMap;
  for (const h of HOTKEYS) map[h.id] = overrides[h.id] ?? h.defaults;
  return map;
}

export function actionForKey(map: HotkeyMap, key: string): HotkeyAction | null {
  const k = normalizeKey(key);
  for (const h of HOTKEYS) if (map[h.id].includes(k)) return h.id;
  return null;
}

/**
 * Bind `key` to `action` alone. Any other action that used the key loses it,
 * so one key never does two things.
 */
export function assignHotkey(
  overrides: HotkeyOverrides,
  action: HotkeyAction,
  key: string
): HotkeyOverrides {
  const k = normalizeKey(key);
  const map = resolveHotkeys(overrides);
  const next: HotkeyOverrides = { ...overrides, [action]: [k] };
  for (const h of HOTKEYS) {
    if (h.id !== action && map[h.id].includes(k)) {
      next[h.id] = map[h.id].filter((x) => x !== k);
    }
  }
  return next;
}

/** Back to the default keys, taking them from any action that holds them now. */
export function resetHotkey(
  overrides: HotkeyOverrides,
  action: HotkeyAction
): HotkeyOverrides {
  const next = { ...overrides };
  delete next[action];
  const defaults = HOTKEYS.find((h) => h.id === action)?.defaults ?? [];
  const map = resolveHotkeys(next);
  for (const h of HOTKEYS) {
    if (h.id !== action && map[h.id].some((k) => defaults.includes(k))) {
      next[h.id] = map[h.id].filter((k) => !defaults.includes(k));
    }
  }
  return next;
}

const KEY_LABELS: Record<string, string> = {
  " ": "Space",
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
};

export function keyLabel(key: string): string {
  return KEY_LABELS[key] ?? (key.length === 1 ? key.toUpperCase() : key);
}

/** Saved overrides from storage or the server: drop anything malformed. */
export function normalizeHotkeyOverrides(value: unknown): HotkeyOverrides {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: HotkeyOverrides = {};
  for (const [id, keys] of Object.entries(value as Record<string, unknown>)) {
    if (!ACTION_IDS.has(id) || !Array.isArray(keys)) continue;
    out[id as HotkeyAction] = keys
      .filter((k): k is string => typeof k === "string" && isBindableKey(k))
      .map(normalizeKey)
      .slice(0, 4);
  }
  return out;
}
