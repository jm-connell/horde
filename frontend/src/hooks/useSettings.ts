import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
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
  | "custom-image"
  | "rain"
  | "constellation"
  | "perlin-flow"
  | "matrix"
  | "snow"
  | "fireflies"
  | "dust"
  | "bokeh"
  | "warp-grid"
  | "scanlines"
  | "grain"
  | "modern-grid"
  | "flowing-gradient"
  | "lightspeed";

export type FlowingGradientPreset =
  | "theme"
  | "rgb"
  | "cool"
  | "warm"
  | "mono";

export type HoverMotion = "off" | "subtle" | "lift" | "glow";
export type NavIndicator = "none" | "liquid" | "underline" | "fade";
export type LoadingStyle = "dots" | "spinner" | "bar";
export type UiScale = "80" | "90" | "100" | "110" | "125" | "150" | "175";

export interface CustomThemePreset {
  id: string;
  name: string;
  customColors: CustomColors;
  backgroundEffect: BackgroundEffect;
  backgroundOpacity: number;
  backgroundEffectSpeed: number;
  backgroundEffectSize: number;
  backgroundEffectColorMode: "accent" | "custom";
  backgroundEffectColor: string;
  flowingGradientPreset: FlowingGradientPreset;
  customBackgroundId: string | null;
  customBackgroundMime: string | null;
  customBackgroundBlur: number;
  customBackgroundTint: string;
  customBackgroundTintOpacity: number;
}

export interface Settings {
  theme: Theme;
  customColors: CustomColors;
  customThemes: CustomThemePreset[];
  backgroundEffect: BackgroundEffect;
  backgroundOpacity: number;
  backgroundEffectSpeed: number;
  backgroundEffectSize: number;
  backgroundEffectColorMode: "accent" | "custom";
  backgroundEffectColor: string;
  flowingGradientPreset: FlowingGradientPreset;
  customBackgroundId: string | null;
  customBackgroundMime: string | null;
  customBackgroundBlur: number;
  customBackgroundTint: string;
  customBackgroundTintOpacity: number;
  pauseBackgroundWhileWatching: boolean;
  navIndicator: NavIndicator;
  hoverMotion: HoverMotion;
  translucentPanels: boolean;
  /** 0.15–1 when panels are translucent; higher = more see-through. */
  translucentPanelStrength: number;
  /** Raise opacity / tint on panels marked .ui-panel-legible. */
  translucentPanelLegibility: boolean;
  loadingStyle: LoadingStyle;
  /** Rem-based UI scale applied to documentElement font-size. */
  uiScale: UiScale;
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
  showCardDates: boolean;
  progressExpiryDays: number;
  sponsorBlockEnabled: boolean;
  sponsorBlockShowNotice: boolean;
  sidebarCollapsed: boolean;
  chaptersExpanded: boolean;
  descriptionExpanded: boolean;
  showRelatedVideos: boolean;
  /** When true, show up-next countdown for related videos after end (queue still advances immediately). */
  autoplayRelated: boolean;
}

const DEFAULT_CUSTOM_COLORS: CustomColors = {
  accent: "#22d3ee",
  background: "#08090c",
};

const DEFAULTS: Settings = {
  theme: "default",
  customColors: DEFAULT_CUSTOM_COLORS,
  customThemes: [],
  backgroundEffect: "none",
  backgroundOpacity: 0.45,
  backgroundEffectSpeed: 1,
  backgroundEffectSize: 1,
  flowingGradientPreset: "theme",
  customBackgroundId: null,
  customBackgroundMime: null,
  customBackgroundBlur: 12,
  customBackgroundTint: "#08090c",
  customBackgroundTintOpacity: 0.45,
  backgroundEffectColorMode: "accent",
  backgroundEffectColor: "#22d3ee",
  pauseBackgroundWhileWatching: false,
  navIndicator: "liquid",
  hoverMotion: "subtle",
  translucentPanels: false,
  translucentPanelStrength: 0.65,
  translucentPanelLegibility: true,
  loadingStyle: "dots",
  uiScale: "100",
  showDescription: true,
  subtitleSize: "medium",
  subtitleOffset: 12,
  defaultPlaybackRate: 1,
  volume: 1,
  playbackMode: "standard",
  lastCustomChannel: "",
  showContinueWatching: true,
  showDownloadNavBadge: true,
  normalizeVolumeOnDownload: true,
  channelSort: "recent_download",
  channelOrder: "desc",
  defaultLibrarySort: "added_at",
  showProgressOnContinueWatching: true,
  showProgressOnAllVideos: false,
  showCardDates: true,
  progressExpiryDays: 14,
  sponsorBlockEnabled: false,
  sponsorBlockShowNotice: true,
  sidebarCollapsed: false,
  chaptersExpanded: true,
  descriptionExpanded: true,
  showRelatedVideos: true,
  autoplayRelated: true,
};

/** Keys persisted to server `ui` blob (excludes ephemeral/session fields). */
const SERVER_UI_KEYS: (keyof Settings)[] = [
  "theme",
  "customColors",
  "customThemes",
  "backgroundEffect",
  "backgroundOpacity",
  "backgroundEffectSpeed",
  "backgroundEffectSize",
  "backgroundEffectColorMode",
  "backgroundEffectColor",
  "flowingGradientPreset",
  "customBackgroundId",
  "customBackgroundMime",
  "customBackgroundBlur",
  "customBackgroundTint",
  "customBackgroundTintOpacity",
  "pauseBackgroundWhileWatching",
  "navIndicator",
  "hoverMotion",
  "translucentPanels",
  "translucentPanelStrength",
  "translucentPanelLegibility",
  "loadingStyle",
  "uiScale",
  "showDescription",
  "subtitleSize",
  "subtitleOffset",
  "defaultPlaybackRate",
  "playbackMode",
  "showContinueWatching",
  "showDownloadNavBadge",
  "normalizeVolumeOnDownload",
  "channelSort",
  "channelOrder",
  "defaultLibrarySort",
  "showProgressOnContinueWatching",
  "showProgressOnAllVideos",
  "showCardDates",
  "sponsorBlockEnabled",
  "sponsorBlockShowNotice",
  "sidebarCollapsed",
  "chaptersExpanded",
  "descriptionExpanded",
  "showRelatedVideos",
  "autoplayRelated",
];

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
  "custom-image",
  "rain",
  "constellation",
  "perlin-flow",
  "matrix",
  "snow",
  "fireflies",
  "dust",
  "bokeh",
  "warp-grid",
  "scanlines",
  "grain",
  "modern-grid",
  "flowing-gradient",
  "lightspeed",
]);

const VALID_FLOWING_PRESETS = new Set<string>([
  "theme",
  "rgb",
  "cool",
  "warm",
  "mono",
]);

const VALID_HOVER_MOTION = new Set<string>(["off", "subtle", "lift", "glow"]);
const VALID_NAV_INDICATOR = new Set<string>([
  "none",
  "liquid",
  "underline",
  "fade",
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
  if (effect === "aurora") return "flowing-gradient";
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

function normalizeBackgroundSize(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return DEFAULTS.backgroundEffectSize;
  return Math.min(2, Math.max(0.5, n));
}

function normalizeTranslucentStrength(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return DEFAULTS.translucentPanelStrength;
  return Math.min(1, Math.max(0.15, n));
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

function normalizeHoverMotion(value: unknown): HoverMotion {
  if (typeof value === "string" && VALID_HOVER_MOTION.has(value)) {
    return value as HoverMotion;
  }
  return DEFAULTS.hoverMotion;
}

function normalizeNavIndicator(
  value: unknown,
  legacyLiquid?: unknown
): NavIndicator {
  if (typeof value === "string" && VALID_NAV_INDICATOR.has(value)) {
    return value as NavIndicator;
  }
  // Migrate old liquidNav boolean
  if (typeof legacyLiquid === "boolean") {
    return legacyLiquid ? "liquid" : "none";
  }
  return DEFAULTS.navIndicator;
}

function normalizeBool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeCustomColors(value: unknown): CustomColors {
  if (!value || typeof value !== "object") return DEFAULT_CUSTOM_COLORS;
  const v = value as Partial<CustomColors>;
  return {
    accent:
      typeof v.accent === "string" ? v.accent : DEFAULT_CUSTOM_COLORS.accent,
    background:
      typeof v.background === "string"
        ? v.background
        : DEFAULT_CUSTOM_COLORS.background,
  };
}

function camelToSnake(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

function snakeToCamel(key: string): string {
  return key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

export function settingsToServerUi(settings: Settings): Record<string, unknown> {
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
  return patch as Partial<Settings>;
}

const VALID_UI_SCALES = new Set<string>([
  "80",
  "90",
  "100",
  "110",
  "125",
  "150",
  "175",
]);

function normalizeUiScale(value: unknown): UiScale {
  if (typeof value === "string" && VALID_UI_SCALES.has(value)) {
    return value as UiScale;
  }
  return DEFAULTS.uiScale;
}

function normalizeFlowingPreset(value: unknown): FlowingGradientPreset {
  if (typeof value === "string" && VALID_FLOWING_PRESETS.has(value)) {
    return value as FlowingGradientPreset;
  }
  return DEFAULTS.flowingGradientPreset;
}

function normalizeCustomBgId(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  return null;
}

function normalizeCustomBgBlur(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return DEFAULTS.customBackgroundBlur;
  return Math.min(40, Math.max(0, n));
}

function normalizeTintOpacity(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return DEFAULTS.customBackgroundTintOpacity;
  return Math.min(1, Math.max(0, n));
}

function normalizeCustomThemes(value: unknown): CustomThemePreset[] {
  if (!Array.isArray(value)) return [];
  const out: CustomThemePreset[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Partial<CustomThemePreset>;
    if (typeof r.id !== "string" || typeof r.name !== "string") continue;
    out.push({
      id: r.id,
      name: r.name.slice(0, 64),
      customColors: normalizeCustomColors(r.customColors),
      backgroundEffect: normalizeBackgroundEffect(r.backgroundEffect),
      backgroundOpacity: normalizeBackgroundOpacity(r.backgroundOpacity),
      backgroundEffectSpeed: normalizeBackgroundSpeed(r.backgroundEffectSpeed),
      backgroundEffectSize: normalizeBackgroundSize(r.backgroundEffectSize),
      backgroundEffectColorMode: normalizeBackgroundColorMode(
        r.backgroundEffectColorMode
      ),
      backgroundEffectColor: normalizeBackgroundColor(r.backgroundEffectColor),
      flowingGradientPreset: normalizeFlowingPreset(r.flowingGradientPreset),
      customBackgroundId: normalizeCustomBgId(r.customBackgroundId),
      customBackgroundMime:
        typeof r.customBackgroundMime === "string"
          ? r.customBackgroundMime
          : null,
      customBackgroundBlur: normalizeCustomBgBlur(r.customBackgroundBlur),
      customBackgroundTint: normalizeBackgroundColor(
        r.customBackgroundTint ?? DEFAULTS.customBackgroundTint
      ),
      customBackgroundTintOpacity: normalizeTintOpacity(
        r.customBackgroundTintOpacity
      ),
    });
  }
  return out.slice(0, 40);
}

function normalizeSettings(parsed: Partial<Settings> & { liquidNav?: boolean }): Settings {
  return {
    ...DEFAULTS,
    ...parsed,
    theme: normalizeTheme(parsed.theme),
    customColors: normalizeCustomColors(parsed.customColors),
    customThemes: normalizeCustomThemes(parsed.customThemes),
    backgroundEffect: normalizeBackgroundEffect(parsed.backgroundEffect),
    backgroundOpacity: normalizeBackgroundOpacity(parsed.backgroundOpacity),
    backgroundEffectSpeed: normalizeBackgroundSpeed(
      parsed.backgroundEffectSpeed
    ),
    backgroundEffectSize: normalizeBackgroundSize(parsed.backgroundEffectSize),
    backgroundEffectColorMode: normalizeBackgroundColorMode(
      parsed.backgroundEffectColorMode
    ),
    backgroundEffectColor: normalizeBackgroundColor(
      parsed.backgroundEffectColor
    ),
    flowingGradientPreset: normalizeFlowingPreset(parsed.flowingGradientPreset),
    customBackgroundId: normalizeCustomBgId(parsed.customBackgroundId),
    customBackgroundMime:
      typeof parsed.customBackgroundMime === "string"
        ? parsed.customBackgroundMime
        : null,
    customBackgroundBlur: normalizeCustomBgBlur(parsed.customBackgroundBlur),
    customBackgroundTint: normalizeBackgroundColor(
      parsed.customBackgroundTint ?? DEFAULTS.customBackgroundTint
    ),
    customBackgroundTintOpacity: normalizeTintOpacity(
      parsed.customBackgroundTintOpacity
    ),
    pauseBackgroundWhileWatching: normalizeBool(
      parsed.pauseBackgroundWhileWatching,
      DEFAULTS.pauseBackgroundWhileWatching
    ),
    navIndicator: normalizeNavIndicator(
      parsed.navIndicator,
      (parsed as { liquidNav?: boolean }).liquidNav
    ),
    hoverMotion: normalizeHoverMotion(parsed.hoverMotion),
    translucentPanels: normalizeBool(
      parsed.translucentPanels,
      DEFAULTS.translucentPanels
    ),
    translucentPanelStrength: normalizeTranslucentStrength(
      parsed.translucentPanelStrength
    ),
    translucentPanelLegibility: normalizeBool(
      parsed.translucentPanelLegibility,
      DEFAULTS.translucentPanelLegibility
    ),
    uiScale: normalizeUiScale(parsed.uiScale),
  };
}

export function applyMotionPrefs(settings: Settings): void {
  const root = document.documentElement;
  const reduced =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  root.dataset.navIndicator = reduced ? "none" : settings.navIndicator;
  root.dataset.hoverMotion = reduced ? "off" : settings.hoverMotion;
  root.dataset.buttonPress = reduced ? "off" : "on";
  root.dataset.pageFade = reduced ? "off" : "on";
  root.dataset.translucentPanels = settings.translucentPanels ? "on" : "off";
  root.dataset.panelLegibility =
    settings.translucentPanels && settings.translucentPanelLegibility
      ? "on"
      : "off";
  // Strength → panel fill alpha (lower = more see-through) and blur.
  // High strength keeps blur low so particle effects stay visible.
  const s = settings.translucentPanelStrength;
  const fill = (0.78 - s * 0.55).toFixed(3); // 0.15→0.70, 1→0.23
  const headerFill = (0.85 - s * 0.5).toFixed(3);
  const cardFill = (0.82 - s * 0.5).toFixed(3);
  const blur = Math.max(0, Math.round(14 - s * 12)); // 0.15→12px, 1→2px
  root.style.setProperty("--ui-panel-alpha", fill);
  root.style.setProperty("--ui-panel-header-alpha", headerFill);
  root.style.setProperty("--ui-panel-card-alpha", cardFill);
  root.style.setProperty("--ui-panel-blur", `${blur}px`);

  const scalePct = Number(settings.uiScale) || 100;
  root.style.fontSize = `${(16 * scalePct) / 100}px`;
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<Settings> & { liquidNav?: boolean };
    return normalizeSettings(parsed);
  } catch {
    return DEFAULTS;
  }
}

function persistLocal(settings: Settings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  window.dispatchEvent(new Event(EVENT));
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

const EVENT = "horde:settings-changed";

let syncTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleServerSync(settings: Settings): void {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = null;
    const ui = settingsToServerUi(settings);
    api.updateAppSettings({ ui }).catch(() => undefined);
  }, 300);
}

export function useSettings(): [Settings, (patch: Partial<Settings>) => void] {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const hydrated = useRef(false);

  useEffect(() => {
    const sync = () => setSettings(loadSettings());
    window.addEventListener(EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  // Hydrate from server once
  useEffect(() => {
    let cancelled = false;
    api
      .getAppSettings()
      .then((remote) => {
        if (cancelled) return;
        const local = loadSettings();
        const ui = remote.ui && typeof remote.ui === "object" ? remote.ui : {};
        const hasServerUi = Object.keys(ui).length > 0;

        if (hasServerUi) {
          const patch = serverUiToSettingsPatch(ui);
          const next = normalizeSettings({
            ...local,
            ...patch,
            progressExpiryDays: remote.progress_expiry_days,
          });
          persistLocal(next);
        } else {
          // Migrate local → server
          const uiPayload = settingsToServerUi(local);
          if (Object.keys(uiPayload).length > 0) {
            api
              .updateAppSettings({
                ui: uiPayload,
                progress_expiry_days: remote.progress_expiry_days,
              })
              .catch(() => undefined);
          }
          if (remote.progress_expiry_days !== local.progressExpiryDays) {
            persistLocal({
              ...local,
              progressExpiryDays: remote.progress_expiry_days,
            });
          }
        }
        hydrated.current = true;
      })
      .catch(() => {
        hydrated.current = true;
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    applyTheme(settings.theme, settings.customColors);
  }, [settings.theme, settings.customColors]);

  const prevUiScale = useRef(settings.uiScale);

  useEffect(() => {
    const scaleChanged = prevUiScale.current !== settings.uiScale;
    const pinEl = scaleChanged
      ? document.querySelector<HTMLElement>("[data-ui-scale-control]")
      : null;
    const oldTop = pinEl?.getBoundingClientRect().top ?? null;
    prevUiScale.current = settings.uiScale;

    applyMotionPrefs(settings);

    if (oldTop != null) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const el = document.querySelector<HTMLElement>(
            "[data-ui-scale-control]"
          );
          if (!el) return;
          const newTop = el.getBoundingClientRect().top;
          window.scrollBy(0, newTop - oldTop);
        });
      });
    }
  }, [
    settings.navIndicator,
    settings.hoverMotion,
    settings.translucentPanels,
    settings.translucentPanelStrength,
    settings.translucentPanelLegibility,
    settings.uiScale,
  ]);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => applyMotionPrefs(loadSettings());
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const update = useCallback((patch: Partial<Settings>) => {
    const next = normalizeSettings({ ...loadSettings(), ...patch });
    persistLocal(next);
    scheduleServerSync(next);
  }, []);

  return [settings, update];
}
