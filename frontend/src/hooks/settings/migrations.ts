import { isCustomCssEnabled, normalizeCustomCss } from "../../customCss";
import {
  newCustomFontId,
  normalizeCustomFonts,
  normalizeUiFont,
  parseCustomFontInput,
} from "../../fonts";
import { normalizeHotkeyOverrides } from "../../hotkeys";
import { normalizeTabBarItems } from "../../tabBar";
import { isLoadingStyle } from "../../loadingStyles";
import {
  normalizeSponsorBlockCategories,
  normalizeSponsorBlockSkipMode,
} from "../../sponsorBlock";
import { DEFAULTS, DEFAULT_CUSTOM_COLORS, PANEL_BLUR_MAX_PX } from "./defaults";
import type {
  BackgroundEffect,
  CustomColors,
  CustomThemePreset,
  DownloadVideoCodec,
  FlowingGradientPreset,
  FontSize,
  HoverMotion,
  NavIndicator,
  Settings,
  Theme,
} from "./types";

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

function normalizeUnitInterval(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

export type LegacyPanelFields = {
  translucentPanels?: unknown;
  translucentPanelStrength?: unknown;
  translucentPanelBlur?: unknown;
};

/** Map saved panel fields onto independent transparency + blur sliders. */
export function migratePanelTranslucency(
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

function normalizeBackgroundColorMode(value: unknown): "accent" | "custom" {
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

export function normalizeDownloadVideoCodec(
  value: unknown
): DownloadVideoCodec {
  const raw = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[-._+]/g, "");
  if (raw === "sidecar" || raw === "dual" || raw === "av1h264")
    return "sidecar";
  if (raw === "h264native" || raw === "native") return "h264_native";
  // Legacy "h264" / "h265" were per-download transcode targets.
  if (
    [
      "h264convert",
      "h264",
      "avc",
      "avc1",
      "h265",
      "hevc",
      "hvc1",
      "hev1",
    ].includes(raw)
  ) {
    return "h264_convert";
  }
  return "av1";
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

const VALID_FONT_SIZES = new Set<string>(["small", "medium", "large", "xl"]);

function normalizeFontSize(value: unknown, legacyUiScale?: unknown): FontSize {
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
      customCssEnabled: isCustomCssEnabled(
        r.customCssEnabled,
        r.customCss ?? ""
      ),
    });
  }
  return out.slice(0, 40);
}

export function normalizeSettings(
  parsed: Partial<Settings> & {
    liquidNav?: boolean;
    translucentPanels?: boolean;
    uiScale?: unknown;
    aiTab?: unknown;
  }
): Settings {
  const rest = { ...parsed };
  delete rest.liquidNav;
  delete rest.translucentPanels;
  delete rest.uiScale;
  delete rest.aiTab;
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
    playerShortcuts: normalizeBool(
      parsed.playerShortcuts,
      DEFAULTS.playerShortcuts
    ),
    hotkeys: normalizeHotkeyOverrides(parsed.hotkeys),
    tabBarItems: normalizeTabBarItems(parsed.tabBarItems),
    previewOnHover: normalizeBool(
      parsed.previewOnHover,
      DEFAULTS.previewOnHover
    ),
    previewMuted: normalizeBool(parsed.previewMuted, DEFAULTS.previewMuted),
    downloadVideoCodec: normalizeDownloadVideoCodec(parsed.downloadVideoCodec),
    compatCopyResolution:
      parsed.compatCopyResolution === "source" ? "source" : "1080p",
    helpChatData:
      parsed.helpChatData === "local" || parsed.helpChatData === "cloud"
        ? parsed.helpChatData
        : "off",
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
  let uiFont = parsed.uiFont ?? DEFAULTS.uiFont;

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
