import type { BackgroundEffect } from "../hooks/useSettings";
import type { EffectController } from "./shared";
import { effectOptions, type AnimatedEffect } from "./controls";
import { createConstellationEffect } from "./constellation";
import { createContoursEffect } from "./contours";
import { createDustEffect } from "./dust";
import {
  createFlowingGradientEffect,
  type FlowingGradientPreset,
} from "./flowingGradient";
import { createLightspeedEffect } from "./lightspeed";
import { createMatrixEffect } from "./matrix";
import { createMeshGradientEffect } from "./meshGradient";
import { createModernGridEffect } from "./modernGrid";
import { createNorthernLightsEffect } from "./northernLights";
import { createRainEffect } from "./rain";
import { createScanlinesEffect } from "./scanlines";
import { createSilkEffect } from "./silk";
import { createSnowfallEffect } from "./snowfall";
import { createSpiralGalaxyEffect } from "./spiralGalaxy";
import { createWarpGridEffect } from "./warpGrid";
import { SHADER_FAILED } from "./webgl";

export { SHADER_FAILED } from "./webgl";

export type { FlowingGradientPreset } from "./flowingGradient";
export { FLOWING_PRESET_OPTIONS } from "./flowingGradient";

/** None and Custom image first, then the effects by label, A to Z. */
export const BACKGROUND_EFFECT_OPTIONS: {
  value: BackgroundEffect;
  label: string;
  description: string;
}[] = [
  { value: "none", label: "None", description: "Solid theme background" },
  {
    value: "custom-image",
    label: "Custom image",
    description: "Uploaded still or animated background",
  },
  {
    value: "constellation",
    label: "Constellation",
    description: "Drifting linked stars",
  },
  {
    value: "contours",
    label: "Contours",
    description: "Survey-map lines over land that slowly reshapes",
  },
  { value: "dust", label: "Dust", description: "Rising motes in the air" },
  {
    value: "lightspeed",
    label: "Lightspeed",
    description: "Subtle tunnel of light streaks",
  },
  { value: "matrix", label: "Matrix", description: "Cascading glyph rain" },
  {
    value: "mesh-gradient",
    label: "Mesh gradient",
    description: "Colors drifting and blending, smooth and banding-free",
  },
  {
    value: "modern-grid",
    label: "Modern grid",
    description: "Color gradient with a grid and floating dust",
  },
  {
    value: "northern-lights",
    label: "Northern lights",
    description: "Curtains of light rippling across the sky",
  },
  {
    value: "rain",
    label: "Rain",
    description: "Soft rain in three depths, slanted by the wind",
  },
  {
    value: "scanlines",
    label: "Scanlines",
    description: "CRT-style line sweep",
  },
  {
    value: "silk",
    label: "Silk",
    description: "Slow folds of satin with a sheen along each crest",
  },
  {
    value: "snowfall",
    label: "Snowfall",
    description: "Snow in three depths, moved by one gusting wind",
  },
  {
    value: "spiral-galaxy",
    label: "Spiral galaxy",
    description: "Two arms of stars wheeling round a bright core",
  },
  {
    value: "warp-grid",
    label: "Warp grid",
    description: "A grid gently distorted by noise",
  },
];

type EffectFactory = (canvas: HTMLCanvasElement) => EffectController;

/** The 2D canvas effects; the three shader effects start below. */
const FACTORIES: Partial<Record<AnimatedEffect, EffectFactory>> = {
  constellation: createConstellationEffect,
  contours: createContoursEffect,
  dust: createDustEffect,
  lightspeed: createLightspeedEffect,
  matrix: createMatrixEffect,
  "modern-grid": createModernGridEffect,
  rain: createRainEffect,
  scanlines: createScanlinesEffect,
  snowfall: createSnowfallEffect,
  "spiral-galaxy": createSpiralGalaxyEffect,
  "warp-grid": createWarpGridEffect,
};

let flowingPresetGetter: (() => FlowingGradientPreset) | null = null;

export function setFlowingGradientPresetGetter(
  getter: (() => FlowingGradientPreset) | null
) {
  flowingPresetGetter = getter;
}

/**
 * Start effect `id` on `canvas`, with its sliders at their defaults until
 * the caller pushes the saved ones (`setOptions`). `shaders: false` runs a
 * shader effect's 2D stand-in (Flowing gradient) straight away: the caller
 * passes it after an earlier start returned SHADER_FAILED, on a fresh canvas.
 */
export function createBackgroundEffect(
  id: BackgroundEffect,
  canvas: HTMLCanvasElement,
  shaders = true
): EffectController | null | typeof SHADER_FAILED {
  if (id === "custom-image" || id === "none") return null;
  const controller = startEffect(id, canvas, shaders);
  if (controller && controller !== SHADER_FAILED) {
    controller.setOptions(effectOptions(id, undefined));
  }
  return controller;
}

function startEffect(
  id: AnimatedEffect,
  canvas: HTMLCanvasElement,
  shaders: boolean
): EffectController | null | typeof SHADER_FAILED {
  const preset = () => flowingPresetGetter?.() ?? "theme";
  if (id === "northern-lights" || id === "silk" || id === "mesh-gradient") {
    const shader = !shaders
      ? null
      : id === "northern-lights"
        ? createNorthernLightsEffect(canvas)
        : id === "silk"
          ? createSilkEffect(canvas)
          : createMeshGradientEffect(canvas, preset);
    // No hardware WebGL here: the canvas is still free for the 2D stand-in.
    return shader ?? createFlowingGradientEffect(canvas, preset);
  }
  return FACTORIES[id]?.(canvas) ?? null;
}
