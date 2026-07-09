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

export type BackgroundEffect =
  | "none"
  | "rain"
  | "constellation"
  | "perlin-flow"
  | "aurora"
  | "matrix"
  | "snow"
  | "fireflies"
  | "dust"
  | "bokeh"
  | "warp-grid"
  | "scanlines"
  | "grain";

export type HoverMotion = "off" | "subtle" | "lift" | "glow";

export interface Settings {
  theme: Theme;
  customColors: CustomColors;
  backgroundEffect: BackgroundEffect;
  backgroundOpacity: number;
  backgroundEffectSpeed: number;
  backgroundEffectColorMode: "accent" | "custom";
  backgroundEffectColor: string;
  pauseBackgroundWhileWatching: boolean;
  liquidNav: boolean;
  hoverMotion: HoverMotion;
  buttonPress: boolean;
  pageFade: boolean;
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
  showRelatedVideos: boolean;
}

const DEFAULT_CUSTOM_COLORS: CustomColors = {
  accent: "#22d3ee",
  background: "#08090c",
};

const DEFAULTS: Settings = {
  theme: "default",
  customColors: DEFAULT_CUSTOM_COLORS,
  backgroundEffect: "none",
  backgroundOpacity: 0.45,
  backgroundEffectSpeed: 1,
  backgroundEffectColorMode: "accent",
  backgroundEffectColor: "#22d3ee",
  pauseBackgroundWhileWatching: true,
  liquidNav: true,
  hoverMotion: "subtle",
  buttonPress: true,
  pageFade: true,
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
  showRelatedVideos: true,
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

const VALID_BACKGROUND_EFFECTS = new Set<string>([
  "none",
  "rain",
  "constellation",
  "perlin-flow",
  "aurora",
  "matrix",
  "snow",
  "fireflies",
  "dust",
  "bokeh",
  "warp-grid",
  "scanlines",
  "grain",
]);

function normalizeTheme(theme: string | undefined): Theme {
  if (!theme) return DEFAULTS.theme;
  if (theme in LEGACY_THEMES) return LEGACY_THEMES[theme];
  if (VALID_THEMES.has(theme)) return theme as Theme;
  return DEFAULTS.theme;
}

function normalizeBackgroundEffect(
  effect: string | undefined
): BackgroundEffect {
  if (effect && VALID_BACKGROUND_EFFECTS.has(effect)) {
    return effect as BackgroundEffect;
  }
  return DEFAULTS.backgroundEffect;
}

function normalizeBackgroundOpacity(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return DEFAULTS.backgroundOpacity;
  return Math.min(1, Math.max(0.1, n));
}

function normalizeBackgroundSpeed(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return DEFAULTS.backgroundEffectSpeed;
  return Math.min(3, Math.max(0.25, n));
}

function normalizeBackgroundColorMode(
  value: unknown
): "accent" | "custom" {
  return value === "custom" ? "custom" : "accent";
}

function normalizeBackgroundColor(value: unknown): string {
  if (typeof value !== "string") return DEFAULTS.backgroundEffectColor;
  const hex = value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(hex)) return hex.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(hex)) {
    const raw = hex.slice(1);
    return `#${raw[0]}${raw[0]}${raw[1]}${raw[1]}${raw[2]}${raw[2]}`.toLowerCase();
  }
  return DEFAULTS.backgroundEffectColor;
}

const VALID_HOVER_MOTION = new Set<string>(["off", "subtle", "lift", "glow"]);

function normalizeHoverMotion(value: unknown): HoverMotion {
  if (typeof value === "string" && VALID_HOVER_MOTION.has(value)) {
    return value as HoverMotion;
  }
  return DEFAULTS.hoverMotion;
}

function normalizeBool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function applyMotionPrefs(settings: Settings): void {
  const root = document.documentElement;
  const reduced =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  root.dataset.liquidNav = !reduced && settings.liquidNav ? "on" : "off";
  root.dataset.hoverMotion = reduced ? "off" : settings.hoverMotion;
  root.dataset.buttonPress = !reduced && settings.buttonPress ? "on" : "off";
  root.dataset.pageFade = !reduced && settings.pageFade ? "on" : "off";
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
      backgroundEffect: normalizeBackgroundEffect(parsed.backgroundEffect),
      backgroundOpacity: normalizeBackgroundOpacity(parsed.backgroundOpacity),
      backgroundEffectSpeed: normalizeBackgroundSpeed(
        parsed.backgroundEffectSpeed
      ),
      backgroundEffectColorMode: normalizeBackgroundColorMode(
        parsed.backgroundEffectColorMode
      ),
      backgroundEffectColor: normalizeBackgroundColor(
        parsed.backgroundEffectColor
      ),
      pauseBackgroundWhileWatching: normalizeBool(
        parsed.pauseBackgroundWhileWatching,
        DEFAULTS.pauseBackgroundWhileWatching
      ),
      liquidNav: normalizeBool(parsed.liquidNav, DEFAULTS.liquidNav),
      hoverMotion: normalizeHoverMotion(parsed.hoverMotion),
      buttonPress: normalizeBool(parsed.buttonPress, DEFAULTS.buttonPress),
      pageFade: normalizeBool(parsed.pageFade, DEFAULTS.pageFade),
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

  useEffect(() => {
    applyMotionPrefs(settings);
  }, [
    settings.liquidNav,
    settings.hoverMotion,
    settings.buttonPress,
    settings.pageFade,
  ]);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => applyMotionPrefs(loadSettings());
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const update = useCallback((patch: Partial<Settings>) => {
    const next = { ...loadSettings(), ...patch };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    window.dispatchEvent(new Event(EVENT));
  }, []);

  return [settings, update];
}
