import type { Settings } from "../hooks/useSettings";
import type {
  HelpCatalog,
  HelpCatalogPage,
  HelpCatalogSetting,
} from "../types";

/**
 * The `[[kind:...]]` tokens Ask about Horde writes (the server's prompt lists
 * them, `services/ai/help_chat.py`). Links render where they stand; actions
 * become cards under the reply and do nothing until the user presses them.
 */
export type HelpToken =
  | { kind: "page"; id: string }
  | { kind: "setting"; id: string }
  | { kind: "video"; id: number; title: string }
  | { kind: "set"; id: string; value: string }
  | { kind: "download"; url: string }
  | { kind: "playlist-new"; name: string; videoIds: number[] }
  | { kind: "playlist-add"; playlistId: number; videoIds: number[] };

export type HelpAction = Extract<
  HelpToken,
  { kind: "set" | "download" | "playlist-new" | "playlist-add" }
>;

const TOKEN_RE =
  /\[\[(page|setting|video|set|download|playlist-new|playlist-add):((?:(?!\]\])[^\n]){1,1000})\]\]/g;
const ACTION_KINDS = new Set([
  "set",
  "download",
  "playlist-new",
  "playlist-add",
]);
const ID_RE = /^[a-z0-9-]{1,60}$/;
const MAX_VIDEOS = 200;
const MAX_NAME = 120;

function ids(list: string): number[] | null {
  const out: number[] = [];
  for (const part of list.split(",")) {
    const n = Number(part.trim().replace(/^#/, ""));
    if (!Number.isInteger(n) || n <= 0) return null;
    if (!out.includes(n)) out.push(n);
  }
  return out.length && out.length <= MAX_VIDEOS ? out : null;
}

/** One token's parts, or null when it is malformed. */
export function parseToken(raw: string): HelpToken | null {
  TOKEN_RE.lastIndex = 0;
  const m = TOKEN_RE.exec(raw);
  if (!m || m[0] !== raw) return null;
  const kind = m[1];
  const body = m[2].trim();
  if (kind === "page" || kind === "setting") {
    return ID_RE.test(body) ? { kind, id: body } : null;
  }
  if (kind === "video") {
    const [idPart, ...rest] = body.split("|");
    const id = Number(idPart.trim().replace(/^#/, ""));
    if (!Number.isInteger(id) || id <= 0) return null;
    return { kind, id, title: rest.join("|").trim() || `Video ${id}` };
  }
  if (kind === "set") {
    const eq = body.indexOf("=");
    if (eq < 1) return null;
    const id = body.slice(0, eq).trim();
    const value = body.slice(eq + 1).trim();
    return ID_RE.test(id) && value ? { kind, id, value } : null;
  }
  if (kind === "download") {
    try {
      const url = new URL(body);
      return url.protocol === "http:" || url.protocol === "https:"
        ? { kind, url: url.toString() }
        : null;
    } catch {
      return null;
    }
  }
  const bar = body.lastIndexOf("|");
  if (bar < 1) return null;
  const head = body.slice(0, bar).trim();
  const videoIds = ids(body.slice(bar + 1));
  if (!videoIds) return null;
  if (kind === "playlist-new") {
    return head && head.length <= MAX_NAME
      ? { kind, name: head, videoIds }
      : null;
  }
  const playlistId = Number(head.replace(/^#/, ""));
  return Number.isInteger(playlistId) && playlistId > 0
    ? { kind: "playlist-add", playlistId, videoIds }
    : null;
}

/**
 * A reply split into the text to show (action tokens taken out) and the
 * actions to offer under it, each once.
 */
export function splitActions(content: string): {
  text: string;
  actions: HelpAction[];
} {
  const actions: HelpAction[] = [];
  const seen = new Set<string>();
  const text = content
    .replace(TOKEN_RE, (raw, kind: string) => {
      if (!ACTION_KINDS.has(kind)) return raw;
      const token = parseToken(raw);
      if (token && !seen.has(raw)) {
        seen.add(raw);
        actions.push(token as HelpAction);
      }
      return "";
    })
    .replace(/[ \t]+(\n|$)/g, "$1")
    .replace(/\n{3,}/g, "\n\n");
  return { text, actions };
}

/** The ```css blocks of a reply, for the preview cards. */
export function cssBlocks(content: string): string[] {
  const out: string[] = [];
  for (const m of content.matchAll(/```css[^\n]*\n([\s\S]*?)```/gi)) {
    const css = m[1].trim();
    if (css && !out.includes(css)) out.push(css);
  }
  return out;
}

/** Where a setting lives: its page, tab and pane, and the anchor to flash. */
export function settingHref(s: HelpCatalogSetting): string {
  const params = new URLSearchParams();
  if (s.tab) params.set("tab", s.tab);
  if (s.pane) params.set("pane", s.pane);
  params.set("find", s.anchor || s.id);
  return `${s.path || "/settings"}?${params.toString()}`;
}

export function findSetting(
  catalog: HelpCatalog | undefined,
  id: string
): HelpCatalogSetting | undefined {
  return catalog?.settings.find((s) => s.id === id);
}

export function findPage(
  catalog: HelpCatalog | undefined,
  id: string
): HelpCatalogPage | undefined {
  return catalog?.pages.find((p) => p.id === id);
}

export type SettingValue = string | number | boolean;

/** A proposed value checked against the setting, or why it cannot apply. */
export type Resolved =
  | { ok: true; value: SettingValue; label: string }
  | { ok: false; reason: string };

const TRUE_WORDS = new Set(["true", "on", "yes", "enabled", "1"]);
const FALSE_WORDS = new Set(["false", "off", "no", "disabled", "0"]);

function numberLabel(s: HelpCatalogSetting, n: number): string {
  if (s.format === "percent") return `${Math.round(n * 100)}%`;
  if (s.format === "times") return `${n}×`;
  return String(n);
}

export function resolveValue(s: HelpCatalogSetting, raw: string): Resolved {
  const text = raw.trim().replace(/^["']|["']$/g, "");
  if (s.chat !== "change") {
    return { ok: false, reason: "This one can only be changed in Settings." };
  }
  if (s.type === "bool") {
    const word = text.toLowerCase();
    if (TRUE_WORDS.has(word)) return { ok: true, value: true, label: "On" };
    if (FALSE_WORDS.has(word)) return { ok: true, value: false, label: "Off" };
  } else if (s.type === "enum") {
    const option = (s.options ?? []).find(
      (o) =>
        String(o.value).toLowerCase() === text.toLowerCase() ||
        o.label.toLowerCase() === text.toLowerCase() ||
        (typeof o.value === "number" &&
          Number(text.replace(/[x×]$/i, "")) === o.value)
    );
    if (option) return { ok: true, value: option.value, label: option.label };
  } else if (s.type === "number") {
    let n = Number(text.replace(/[%x×]$/i, ""));
    // "50" or "50%" for a 0–1 setting means half.
    if (s.format === "percent" && (text.endsWith("%") || n > (s.max ?? 1))) {
      n /= 100;
    }
    const min = s.min ?? -Infinity;
    const max = s.max ?? Infinity;
    if (Number.isFinite(n) && n >= min && n <= max) {
      const value = Math.round(n * 100) / 100;
      return { ok: true, value, label: numberLabel(s, value) };
    }
  } else if (s.type === "color") {
    const short = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(text);
    const long = /^#?([0-9a-f]{6})$/i.exec(text);
    const hex = short
      ? `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`
      : long
        ? `#${long[1]}`
        : null;
    if (hex) return { ok: true, value: hex.toLowerCase(), label: hex };
  }
  return { ok: false, reason: `“${text}” is not a value this setting takes.` };
}

type Loose = Record<string, unknown>;

/** The current value at a settings key (`a.b` reads one level down). */
export function readKey(source: object, key: string): unknown {
  const [top, sub] = key.split(".");
  const value = (source as Loose)[top];
  return sub ? ((value ?? {}) as Loose)[sub] : value;
}

/**
 * The `Settings` patch that sets a personal setting (and what it implies,
 * like the Custom theme for an accent color), and the patch that undoes it.
 */
export function personalPatch(
  s: HelpCatalogSetting,
  value: SettingValue,
  settings: Settings
): { apply: Partial<Settings>; undo: Partial<Settings> } {
  const apply: Loose = {};
  const undo: Loose = {};
  const current = settings as unknown as Loose;
  const set = (key: string, v: unknown) => {
    const [top, sub] = key.split(".");
    if (!(top in undo)) undo[top] = current[top];
    apply[top] = sub
      ? { ...((apply[top] ?? current[top] ?? {}) as Loose), [sub]: v }
      : v;
  };
  set(s.key ?? s.id, value);
  for (const [k, v] of Object.entries(s.implies ?? {})) set(k, v);
  return {
    apply: apply as Partial<Settings>,
    undo: undo as Partial<Settings>,
  };
}
