import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { ViewMode } from "../components/videoPlayerTypes";
import {
  applyUiFont,
  newCustomFontId,
  normalizeCustomFonts,
  normalizeUiFont,
  parseCustomFontInput,
  type SavedCustomFont,
  type UiFont,
} from "../fonts";
import {
  applyCustomCss,
  isCustomCssEnabled,
  normalizeCustomCss,
} from "../customCss";
import {
  isLoadingStyle,
  type LoadingStyle,
} from "../loadingStyles";
import {
  DEFAULT_SPONSOR_BLOCK_CATEGORIES,
  normalizeSponsorBlockCategories,
  normalizeSponsorBlockSkipMode,
  type SponsorBlockCategoryMap,
  type SponsorBlockSkipMode,
} from "../sponsorBlock";

export type { LoadingStyle };

export type { SponsorBlockCategoryMap, SponsorBlockSkipMode };

export type { SavedCustomFont, UiFont };

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
  | "earthy"
  | "frozen"
  | "mocha"
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
  | "lightspeed"
  | "galaxy";

export type FlowingGradientPreset =
  | "theme"
  | "rgb"
  | "cool"
  | "warm"
  | "mono";

export type HoverMotion = "off" | "subtle" | "lift" | "glow";
export type NavIndicator = "none" | "liquid" | "underline" | "fade";
/** App text size (rem root). Replaces the old multi-step UI scale. */
export type FontSize = "small" | "medium" | "large" | "xl";

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
  pauseBackgroundWhileWatching: boolean;
  navIndicator: NavIndicator;
  hoverMotion: HoverMotion;
  translucentPanelStrength: number;
  translucentPanelBlur: number;
  translucentPanelTintEnabled: boolean;
  translucentPanelTint: string;
  translucentPanelTintStrength: number;
  translucentPanelLegibility: boolean;
  loadingStyle: LoadingStyle;
  fontSize: FontSize;
  uiFont: string;
  /** User CSS overlay; empty on older snapshots. */
  customCss: string;
  /** Whether the overlay is injected. Inferred from non-empty CSS on old snapshots. */
  customCssEnabled: boolean;
}

export type StreamQuality =
  | "auto"
  | "2160"
  | "1440"
  | "1080"
  | "720"
  | "480";

export interface Settings {
  theme: Theme;
  customColors: CustomColors;
  customThemes: CustomThemePreset[];
  /** Raw CSS injected after built-in theme styles when `customCssEnabled`. */
  customCss: string;
  /** When false, the CSS editor is hidden and the overlay is not injected. */
  customCssEnabled: boolean;
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
  /** 0–1; higher = more see-through. 0 is fully opaque. */
  translucentPanelStrength: number;
  /** 0–1; higher = stronger backdrop blur on translucent panels. */
  translucentPanelBlur: number;
  /** Mix a user-picked color into panel fills. */
  translucentPanelTintEnabled: boolean;
  /** Hex tint mixed into `.ui-panel` / `.ui-card` when enabled. */
  translucentPanelTint: string;
  /** 0–1 mix toward `translucentPanelTint`. */
  translucentPanelTintStrength: number;
  /** Raise opacity / tint on panels marked .ui-panel-legible. */
  translucentPanelLegibility: boolean;
  loadingStyle: LoadingStyle;
  /** Rem-based text size applied to documentElement font-size. */
  fontSize: FontSize;
  /** App typeface (builtin id, saved custom id, or "custom" while adding). */
  uiFont: UiFont;
  /** Permanently saved custom fonts (URL or uploaded file). */
  customFonts: SavedCustomFont[];
  showDescription: boolean;
  subtitleSize: SubtitleSize;
  /** Horizontal caption position (% from left). Default is left-padded so text reads centered-ish. */
  subtitleLeft: number;
  /** Vertical caption position (% from bottom). */
  subtitleOffset: number;
  defaultPlaybackRate: number;
  /** Temporary rate while holding click on the video. */
  holdPlaybackRate: number;
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
  sponsorBlockSkipMode: SponsorBlockSkipMode;
  sponsorBlockCategories: SponsorBlockCategoryMap;
  sidebarCollapsed: boolean;
  chaptersExpanded: boolean;
  descriptionExpanded: boolean;
  /** Watch-page AI panel open/closed (persists across videos and restarts). */
  aiExpanded: boolean;
  /** Last selected AI panel tab when both summary and chat are available. */
  aiTab: "summary" | "chat";
  showRelatedVideos: boolean;
  /** When true, show up-next countdown for related videos after end (queue still advances immediately). */
  autoplayRelated: boolean;
  /** Muted thumbnail preview on mouse hover (desktop / fine pointer). */
  previewOnHover: boolean;
  /** Muted thumbnail preview when a card is uniquely centered (touch / phones). */
  previewWhenCentered: boolean;
  /** On a channel page, include uploads that are not yet in the library. */
  showUndownloadedOnChannel: boolean;
  /** Default quality for adaptive stream playback (Auto = ABR within device cap). */
  defaultStreamQuality: StreamQuality;
}

const DEFAULT_CUSTOM_COLORS: CustomColors = {
  accent: "#22d3ee",
  background: "#08090c",
};

const DEFAULTS: Settings = {
  theme: "default",
  customColors: DEFAULT_CUSTOM_COLORS,
  customThemes: [],
  customCss: "",
  customCssEnabled: false,
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
  translucentPanelStrength: 0.5,
  translucentPanelBlur: 0.5,
  translucentPanelTintEnabled: false,
  translucentPanelTint: "#ffffff",
  translucentPanelTintStrength: 0.35,
  translucentPanelLegibility: true,
  loadingStyle: "dots",
  fontSize: "medium",
  uiFont: "default",
  customFonts: [],
  showDescription: true,
  subtitleSize: "medium",
  subtitleLeft: 20,
  subtitleOffset: 12,
  defaultPlaybackRate: 1,
  holdPlaybackRate: 2,
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
  sponsorBlockEnabled: true,
  sponsorBlockShowNotice: true,
  sponsorBlockSkipMode: "auto",
  sponsorBlockCategories: { ...DEFAULT_SPONSOR_BLOCK_CATEGORIES },
  sidebarCollapsed: false,
  chaptersExpanded: true,
  descriptionExpanded: true,
  aiExpanded: true,
  aiTab: "summary",
  showRelatedVideos: true,
  autoplayRelated: true,
  previewOnHover: true,
  previewWhenCentered: true,
  showUndownloadedOnChannel: true,
  defaultStreamQuality: "auto",
};

/** Keys persisted to server `ui` blob (excludes ephemeral/session fields). */
const SERVER_UI_KEYS: (keyof Settings)[] = [
  "theme",
  "customColors",
  "customThemes",
  "customCss",
  "customCssEnabled",
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
  "translucentPanelStrength",
  "translucentPanelBlur",
  "translucentPanelTintEnabled",
  "translucentPanelTint",
  "translucentPanelTintStrength",
  "translucentPanelLegibility",
  "loadingStyle",
  "fontSize",
  "uiFont",
  "customFonts",
  "showDescription",
  "subtitleSize",
  "subtitleLeft",
  "subtitleOffset",
  "defaultPlaybackRate",
  "holdPlaybackRate",
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
  "sponsorBlockSkipMode",
  "sponsorBlockCategories",
  "sidebarCollapsed",
  "chaptersExpanded",
  "descriptionExpanded",
  "aiExpanded",
  "aiTab",
  "showRelatedVideos",
  "autoplayRelated",
  "previewOnHover",
  "previewWhenCentered",
  "showUndownloadedOnChannel",
  "defaultStreamQuality",
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
  sleek: "default",
  "minimal-teal": "light",
  "vibrant-indigo": "indigo",
  "neon-pop": "cyber",
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
  "earthy",
  "frozen",
  "mocha",
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
  "galaxy",
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

function normalizeHoldPlaybackRate(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return DEFAULTS.holdPlaybackRate;
  return Math.min(16, Math.max(0.25, Math.round(n * 100) / 100));
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

/** Backdrop blur at 100% on the panel blur slider. */
const PANEL_BLUR_MAX_PX = 24;

function normalizeUnitInterval(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

type LegacyPanelFields = {
  translucentPanels?: unknown;
  translucentPanelStrength?: unknown;
  translucentPanelBlur?: unknown;
};

/** Map saved panel fields onto independent transparency + blur sliders. */
function migratePanelTranslucency(
  raw: LegacyPanelFields
): Pick<Settings, "translucentPanelStrength" | "translucentPanelBlur"> {
  const blurN =
    typeof raw.translucentPanelBlur === "number"
      ? raw.translucentPanelBlur
      : Number(raw.translucentPanelBlur);
  const hasBlur =
    raw.translucentPanelBlur != null &&
    raw.translucentPanelBlur !== "" &&
    Number.isFinite(blurN);

  if (hasBlur) {
    return {
      translucentPanelStrength: normalizeUnitInterval(
        raw.translucentPanelStrength,
        DEFAULTS.translucentPanelStrength
      ),
      translucentPanelBlur: normalizeUnitInterval(
        raw.translucentPanelBlur,
        DEFAULTS.translucentPanelBlur
      ),
    };
  }

  // Legacy toggle: off → opaque; on → keep strength and un-couple the old blur.
  if (raw.translucentPanels === true) {
    const s = normalizeUnitInterval(raw.translucentPanelStrength, 0.65);
    const legacyBlurPx = Math.max(0, (1 - s) * 14);
    return {
      translucentPanelStrength: s,
      translucentPanelBlur: Math.min(1, legacyBlurPx / PANEL_BLUR_MAX_PX),
    };
  }

  if (raw.translucentPanels === false) {
    return { translucentPanelStrength: 0, translucentPanelBlur: 0 };
  }

  return {
    translucentPanelStrength: DEFAULTS.translucentPanelStrength,
    translucentPanelBlur: DEFAULTS.translucentPanelBlur,
  };
}

function normalizeBackgroundColorMode(
  value: unknown
): "accent" | "custom" {
  return value === "custom" ? "custom" : "accent";
}

function normalizeBackgroundColor(
  value: unknown,
  fallback: string = DEFAULTS.backgroundEffectColor
): string {
  if (typeof value !== "string") return fallback;
  const hex = value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(hex)) return hex.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(hex)) {
    const raw = hex.slice(1);
    return `#${raw[0]}${raw[0]}${raw[1]}${raw[1]}${raw[2]}${raw[2]}`.toLowerCase();
  }
  return fallback;
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

const VALID_FONT_SIZES = new Set<string>(["small", "medium", "large", "xl"]);

const FONT_SIZE_SCALE: Record<FontSize, number> = {
  small: 0.9,
  medium: 1,
  large: 1.125,
  xl: 1.25,
};

function normalizeFontSize(
  value: unknown,
  legacyUiScale?: unknown
): FontSize {
  if (typeof value === "string" && VALID_FONT_SIZES.has(value)) {
    return value as FontSize;
  }
  // Migrate old uiScale percentages → small / medium / large
  const n =
    typeof legacyUiScale === "string" || typeof legacyUiScale === "number"
      ? Number(legacyUiScale)
      : NaN;
  if (Number.isFinite(n)) {
    if (n <= 90) return "small";
    if (n >= 125) return "large";
    return "medium";
  }
  return DEFAULTS.fontSize;
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
      pauseBackgroundWhileWatching: normalizeBool(
        r.pauseBackgroundWhileWatching,
        DEFAULTS.pauseBackgroundWhileWatching
      ),
      navIndicator: normalizeNavIndicator(r.navIndicator),
      hoverMotion: normalizeHoverMotion(r.hoverMotion),
      ...migratePanelTranslucency(r as LegacyPanelFields),
      translucentPanelTintEnabled: normalizeBool(
        r.translucentPanelTintEnabled,
        DEFAULTS.translucentPanelTintEnabled
      ),
      translucentPanelTint: normalizeBackgroundColor(
        r.translucentPanelTint,
        DEFAULTS.translucentPanelTint
      ),
      translucentPanelTintStrength: normalizeUnitInterval(
        r.translucentPanelTintStrength,
        DEFAULTS.translucentPanelTintStrength
      ),
      translucentPanelLegibility: normalizeBool(
        r.translucentPanelLegibility,
        DEFAULTS.translucentPanelLegibility
      ),
      loadingStyle: isLoadingStyle(r.loadingStyle)
        ? r.loadingStyle
        : DEFAULTS.loadingStyle,
      fontSize: normalizeFontSize(r.fontSize),
      uiFont:
        typeof r.uiFont === "string" &&
        r.uiFont &&
        r.uiFont !== "custom" &&
        /^[a-zA-Z0-9_-]+$/.test(r.uiFont)
          ? r.uiFont === "inter"
            ? "default"
            : r.uiFont
          : DEFAULTS.uiFont,
      customCss: normalizeCustomCss(r.customCss),
      customCssEnabled: isCustomCssEnabled(r.customCssEnabled, r.customCss ?? ""),
    });
  }
  return out.slice(0, 40);
}

function normalizeSettings(
  parsed: Partial<Settings> & {
    liquidNav?: boolean;
    translucentPanels?: boolean;
    uiScale?: unknown;
  }
): Settings {
  const rest = { ...parsed };
  delete rest.liquidNav;
  delete rest.translucentPanels;
  delete rest.uiScale;
  const panel = migratePanelTranslucency(parsed);

  return {
    ...DEFAULTS,
    ...rest,
    theme: normalizeTheme(parsed.theme),
    customColors: normalizeCustomColors(parsed.customColors),
    customThemes: normalizeCustomThemes(parsed.customThemes),
    customCss: normalizeCustomCss(parsed.customCss),
    customCssEnabled: isCustomCssEnabled(
      parsed.customCssEnabled,
      parsed.customCss ?? ""
    ),
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
    translucentPanelStrength: panel.translucentPanelStrength,
    translucentPanelBlur: panel.translucentPanelBlur,
    translucentPanelTintEnabled: normalizeBool(
      parsed.translucentPanelTintEnabled,
      DEFAULTS.translucentPanelTintEnabled
    ),
    translucentPanelTint: normalizeBackgroundColor(
      parsed.translucentPanelTint,
      DEFAULTS.translucentPanelTint
    ),
    translucentPanelTintStrength: normalizeUnitInterval(
      parsed.translucentPanelTintStrength,
      DEFAULTS.translucentPanelTintStrength
    ),
    translucentPanelLegibility: normalizeBool(
      parsed.translucentPanelLegibility,
      DEFAULTS.translucentPanelLegibility
    ),
    fontSize: normalizeFontSize(
      parsed.fontSize,
      (parsed as { uiScale?: unknown }).uiScale
    ),
    holdPlaybackRate: normalizeHoldPlaybackRate(parsed.holdPlaybackRate),
    sponsorBlockSkipMode: normalizeSponsorBlockSkipMode(
      parsed.sponsorBlockSkipMode
    ),
    sponsorBlockCategories: normalizeSponsorBlockCategories(
      parsed.sponsorBlockCategories
    ),
    previewOnHover: normalizeBool(
      parsed.previewOnHover,
      DEFAULTS.previewOnHover
    ),
    previewWhenCentered: normalizeBool(
      parsed.previewWhenCentered,
      DEFAULTS.previewWhenCentered
    ),
    ...normalizeFontSettings(parsed),
  };
}

/** Migrate legacy single custom font fields into customFonts list. */
function normalizeFontSettings(
  parsed: Partial<Settings> & {
    customFontUrl?: unknown;
    customFontHasFile?: unknown;
  }
): Pick<Settings, "uiFont" | "customFonts"> {
  let customFonts = normalizeCustomFonts(parsed.customFonts);
  let uiFont = parsed.uiFont;

  const legacyUrl =
    typeof parsed.customFontUrl === "string" ? parsed.customFontUrl.trim() : "";
  const legacyHasFile = parsed.customFontHasFile === true;

  if (customFonts.length === 0 && (legacyUrl || legacyHasFile)) {
    // Legacy browser-only file uploads cannot be recovered server-side;
    // URL customs still migrate into the permanent list.
    if (legacyUrl) {
      const id = newCustomFontId();
      const parsed = parseCustomFontInput(legacyUrl);
      customFonts = [
        {
          id,
          name: (parsed.family || "Custom font").slice(0, 64),
          source: "url",
          url: legacyUrl,
        },
      ];
      if (uiFont === "custom") uiFont = id;
    } else if (legacyHasFile && uiFont === "custom") {
      uiFont = "default";
    }
  }

  return {
    customFonts,
    uiFont: normalizeUiFont(uiFont, customFonts),
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
  const s = settings.translucentPanelStrength;
  const b = settings.translucentPanelBlur;
  // 0% transparency keeps Tailwind fills; any amount above enables the sliders.
  root.dataset.translucentPanels = s > 0 ? "on" : "off";
  root.dataset.panelLegibility =
    s > 0 && settings.translucentPanelLegibility ? "on" : "off";
  // Strength → panel fill alpha (lower = more see-through). Blur is independent.
  const fill = (1 - s * 0.95).toFixed(3); // 0→1.00, 0.5→0.525, 1→0.05
  const headerFill = (1 - s * 0.88).toFixed(3); // 0→1.00, 0.5→0.56, 1→0.12
  const blurPx = Math.round(Math.min(1, Math.max(0, b)) * PANEL_BLUR_MAX_PX);
  const tintOn =
    settings.translucentPanelTintEnabled &&
    settings.translucentPanelTintStrength > 0;
  root.dataset.panelTint = tintOn ? "on" : "off";
  const tintMix = Math.round(
    Math.min(1, Math.max(0, settings.translucentPanelTintStrength)) * 100
  );
  root.style.setProperty("--ui-panel-alpha", fill);
  root.style.setProperty("--ui-panel-header-alpha", headerFill);
  root.style.setProperty("--ui-panel-blur", `${blurPx}px`);
  root.style.setProperty(
    "--ui-panel-tint",
    rgbString(parseHex(settings.translucentPanelTint))
  );
  root.style.setProperty("--ui-panel-tint-mix", `${tintMix}%`);

  const scale = FONT_SIZE_SCALE[settings.fontSize] ?? 1;
  root.style.fontSize = `${16 * scale}px`;
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

/** Module-level: one GET /api/settings for the whole app, not per useSettings mount. */
let serverHydratePromise: Promise<void> | null = null;
let serverHydrated = false;

function ensureServerHydration(): Promise<void> {
  if (serverHydrated) return Promise.resolve();
  if (serverHydratePromise) return serverHydratePromise;

  serverHydratePromise = api
    .getAppSettings()
    .then((remote) => {
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
    })
    .catch(() => undefined)
    .finally(() => {
      serverHydrated = true;
    });

  return serverHydratePromise;
}

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

  useEffect(() => {
    const sync = () => setSettings(loadSettings());
    window.addEventListener(EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  // Shared hydrate — only one network call no matter how many subscribers.
  useEffect(() => {
    let cancelled = false;
    void ensureServerHydration().then(() => {
      if (!cancelled) setSettings(loadSettings());
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    applyTheme(settings.theme, settings.customColors);
  }, [settings.theme, settings.customColors]);

  useEffect(() => {
    applyCustomCss(settings.customCss, settings.customCssEnabled);
  }, [settings.customCss, settings.customCssEnabled]);

  useEffect(() => {
    void applyUiFont({
      uiFont: settings.uiFont,
      customFonts: settings.customFonts,
    });
  }, [settings.uiFont, settings.customFonts]);

  const prevFontSize = useRef(settings.fontSize);

  useEffect(() => {
    const sizeChanged = prevFontSize.current !== settings.fontSize;
    const pinEl = sizeChanged
      ? document.querySelector<HTMLElement>("[data-font-size-control]")
      : null;
    const oldTop = pinEl?.getBoundingClientRect().top ?? null;
    prevFontSize.current = settings.fontSize;

    applyMotionPrefs(settings);

    if (oldTop != null) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const el = document.querySelector<HTMLElement>(
            "[data-font-size-control]"
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
    settings.translucentPanelStrength,
    settings.translucentPanelBlur,
    settings.translucentPanelTintEnabled,
    settings.translucentPanelTint,
    settings.translucentPanelTintStrength,
    settings.translucentPanelLegibility,
    settings.fontSize,
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
