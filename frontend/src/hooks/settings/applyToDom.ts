import { mutedTextFor } from "../../utils/contrast";
import { FONT_SIZE_SCALE, PANEL_BLUR_MAX_PX } from "./defaults";
import type { CustomColors, Settings, Theme } from "./types";

const THEME_CSS_VARS = [
  "--ink-950",
  "--ink-900",
  "--ink-800",
  "--ink-700",
  "--ink-600",
  "--accent",
  "--accent-soft",
  "--accent-deep",
  "--text-muted",
  "--accent-text",
] as const;

export type Rgb = [number, number, number];

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

  const surfaces = [
    bg,
    mixRgb(bg, white, 0.08),
    mixRgb(bg, white, 0.14),
    mixRgb(bg, white, 0.22),
  ];
  // Secondary text that stays AA-legible on whatever background was picked.
  root.style.setProperty(
    "--text-muted",
    rgbString(mutedTextFor(surfaces, mixRgb(bg, white, 0.22)))
  );
  // Accent as text colour, adjusted to stay readable on the chosen surfaces.
  root.style.setProperty(
    "--accent-text",
    rgbString(
      mutedTextFor(
        [
          ...surfaces,
          mixRgb(surfaces[1], accent, 0.15),
          mixRgb(surfaces[3], accent, 0.15),
        ],
        accent
      )
    )
  );
  root.style.setProperty("--ink-950", rgbString(bg));
  root.style.setProperty("--ink-900", rgbString(mixRgb(bg, white, 0.08)));
  root.style.setProperty("--ink-800", rgbString(mixRgb(bg, white, 0.14)));
  root.style.setProperty("--ink-700", rgbString(mixRgb(bg, white, 0.22)));
  root.style.setProperty("--ink-600", rgbString(mixRgb(bg, white, 0.35)));
  root.style.setProperty("--accent", rgbString(accent));
  root.style.setProperty(
    "--accent-soft",
    rgbString(mixRgb(accent, white, 0.35))
  );
  root.style.setProperty(
    "--accent-deep",
    rgbString(mixRgb(accent, black, 0.25))
  );
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
