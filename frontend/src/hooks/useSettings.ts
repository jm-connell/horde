import { useCallback, useEffect, useState } from "react";
import type { ViewMode } from "../components/VideoPlayer";

export type SubtitleSize = "small" | "medium" | "large";
export type Theme =
  | "default"
  | "oled"
  | "terminal"
  | "nord"
  | "light"
  | "indigo"
  | "cyber"
  | "sunset"
  | "forest"
  | "slate"
  | "custom";

export interface CustomColors {
  accent: string;
  background: string;
}

export type ChannelSort =
  | "recent_download"
  | "video_count"
  | "alphabetical"
  | "subscriber_count";

export type LibrarySort =
  | "added_at"
  | "published_at"
  | "title"
  | "duration"
  | "file_size"
  | "view_count"
  | "random";

export interface Settings {
  theme: Theme;
  customColors: CustomColors;
  showDescription: boolean;
  subtitleSize: SubtitleSize;
  subtitleOffset: number;
  defaultPlaybackRate: number;
  volume: number;
  playbackMode: ViewMode;
  lastCustomChannel: string;
  showContinueWatching: boolean;
  showDownloadNavBadge: boolean;
  normalizeVolumeOnDownload: boolean;
  channelSort: ChannelSort;
  channelOrder: "asc" | "desc";
  defaultLibrarySort: LibrarySort;
  showProgressOnContinueWatching: boolean;
  showProgressOnAllVideos: boolean;
  progressExpiryDays: number;
  sponsorBlockEnabled: boolean;
  sponsorBlockShowNotice: boolean;
  sidebarCollapsed: boolean;
  chaptersExpanded: boolean;
  descriptionExpanded: boolean;
}

const DEFAULT_CUSTOM_COLORS: CustomColors = {
  accent: "#22d3ee",
  background: "#08090c",
};

const DEFAULTS: Settings = {
  theme: "default",
  customColors: DEFAULT_CUSTOM_COLORS,
  showDescription: true,
  subtitleSize: "medium",
  subtitleOffset: 12,
  defaultPlaybackRate: 1,
  volume: 1,
  playbackMode: "standard",
  lastCustomChannel: "",
  showContinueWatching: true,
  showDownloadNavBadge: true,
  normalizeVolumeOnDownload: false,
  channelSort: "recent_download",
  channelOrder: "desc",
  defaultLibrarySort: "added_at",
  showProgressOnContinueWatching: true,
  showProgressOnAllVideos: false,
  progressExpiryDays: 14,
  sponsorBlockEnabled: false,
  sponsorBlockShowNotice: true,
  sidebarCollapsed: false,
  chaptersExpanded: true,
  descriptionExpanded: true,
};

const STORAGE_KEY = "horde.settings";

const THEME_CSS_VARS = [
  "--ink-950",
  "--ink-900",
  "--ink-800",
  "--ink-700",
  "--ink-600",
  "--accent",
  "--accent-soft",
  "--accent-deep",
] as const;

type Rgb = [number, number, number];

function parseHex(hex: string): Rgb {
  const raw = hex.replace("#", "");
  const value =
    raw.length === 3
      ? raw
          .split("")
          .map((c) => c + c)
          .join("")
      : raw;
  return [
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16),
  ];
}

function rgbString([r, g, b]: Rgb): string {
  return `${r} ${g} ${b}`;
}

function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

function clearCustomThemeVars(): void {
  const root = document.documentElement;
  for (const prop of THEME_CSS_VARS) {
    root.style.removeProperty(prop);
  }
}

function applyCustomColors(colors: CustomColors): void {
  const root = document.documentElement;
  const bg = parseHex(colors.background);
  const accent = parseHex(colors.accent);
  const white: Rgb = [255, 255, 255];
  const black: Rgb = [0, 0, 0];

  root.style.setProperty("--ink-950", rgbString(bg));
  root.style.setProperty("--ink-900", rgbString(mixRgb(bg, white, 0.08)));
  root.style.setProperty("--ink-800", rgbString(mixRgb(bg, white, 0.14)));
  root.style.setProperty("--ink-700", rgbString(mixRgb(bg, white, 0.22)));
  root.style.setProperty("--ink-600", rgbString(mixRgb(bg, white, 0.35)));
  root.style.setProperty("--accent", rgbString(accent));
  root.style.setProperty("--accent-soft", rgbString(mixRgb(accent, white, 0.35)));
  root.style.setProperty("--accent-deep", rgbString(mixRgb(accent, black, 0.25)));
}

const LEGACY_THEMES: Record<string, Theme> = {
  macos: "slate",
  warm: "sunset",
};

const VALID_THEMES = new Set<string>([
  "default",
  "oled",
  "terminal",
  "nord",
  "light",
  "indigo",
  "cyber",
  "sunset",
  "forest",
  "slate",
  "custom",
]);

function normalizeTheme(theme: string | undefined): Theme {
  if (!theme) return DEFAULTS.theme;
  if (theme in LEGACY_THEMES) return LEGACY_THEMES[theme];
  if (VALID_THEMES.has(theme)) return theme as Theme;
  return DEFAULTS.theme;
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      ...DEFAULTS,
      ...parsed,
      theme: normalizeTheme(parsed.theme),
    };
  } catch {
    return DEFAULTS;
  }
}

export function applyTheme(theme: Theme, customColors?: CustomColors): void {
  const root = document.documentElement;

  if (theme === "custom" && customColors) {
    root.setAttribute("data-theme", "custom");
    applyCustomColors(customColors);
    return;
  }

  clearCustomThemeVars();

  if (theme === "default") {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", theme);
  }
}

// Notify listeners in the same tab (the native "storage" event only fires in
// other tabs).
const EVENT = "horde:settings-changed";

export function useSettings(): [Settings, (patch: Partial<Settings>) => void] {
  const [settings, setSettings] = useState<Settings>(loadSettings);

  useEffect(() => {
    const sync = () => setSettings(loadSettings());
    window.addEventListener(EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  useEffect(() => {
    applyTheme(settings.theme, settings.customColors);
  }, [settings.theme, settings.customColors]);

  const update = useCallback((patch: Partial<Settings>) => {
    const next = { ...loadSettings(), ...patch };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    window.dispatchEvent(new Event(EVENT));
  }, []);

  return [settings, update];
}
