import type { BackgroundEffect } from "../hooks/useSettings";
import type { EffectController } from "./shared";
import { createBokehEffect } from "./bokeh";
import { createConstellationEffect } from "./constellation";
import { createContoursEffect } from "./contours";
import { createDustEffect } from "./dust";
import { createFilmEffect } from "./film";
import { createFirefliesEffect } from "./fireflies";
import { createFireflySyncEffect } from "./fireflySync";
import {
  createFlowingGradientEffect,
  type FlowingGradientPreset,
} from "./flowingGradient";
import { createGalaxyEffect } from "./galaxy";
import { createGrainEffect } from "./grain";
import { createHalftoneEffect } from "./halftone";
import { createLightspeedEffect } from "./lightspeed";
import { createMatrixEffect } from "./matrix";
import { createMeshGradientEffect } from "./meshGradient";
import { createModernGridEffect } from "./modernGrid";
import { createNorthernLightsEffect } from "./northernLights";
import { createPerlinFlowEffect } from "./perlinFlow";
import { createPlexusEffect } from "./plexus";
import { createProjectorEffect } from "./projector";
import { createRainEffect } from "./rain";
import { createScanlinesEffect } from "./scanlines";
import { createSilkEffect } from "./silk";
import { createSnowEffect } from "./snow";
import { createSnowfallEffect } from "./snowfall";
import { createSpiralGalaxyEffect } from "./spiralGalaxy";
import { createWarpGridEffect } from "./warpGrid";
import { SHADER_FAILED } from "./webgl";

export { SHADER_FAILED } from "./webgl";

export type { FlowingGradientPreset } from "./flowingGradient";
export { FLOWING_PRESET_OPTIONS } from "./flowingGradient";

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
  { value: "rain", label: "Rain", description: "Falling rain streaks" },
  {
    value: "constellation",
    label: "Constellation",
    description: "Drifting linked stars",
  },
  {
    value: "perlin-flow",
    label: "Perlin flow",
    description: "Particles drifting through a noise field",
  },
  { value: "matrix", label: "Matrix", description: "Cascading glyph rain" },
  { value: "snow", label: "Snow", description: "Gentle drifting flakes" },
  {
    value: "fireflies",
    label: "Fireflies",
    description: "Glowing wandering lights",
  },
  { value: "dust", label: "Dust", description: "Rising motes in the air" },
  { value: "bokeh", label: "Bokeh", description: "Soft out-of-focus orbs" },
  {
    value: "warp-grid",
    label: "Warp grid",
    description: "A grid gently distorted by noise",
  },
  {
    value: "scanlines",
    label: "Scanlines",
    description: "CRT-style line sweep",
  },
  { value: "grain", label: "Film grain", description: "Subtle animated noise" },
  {
    value: "modern-grid",
    label: "Modern grid",
    description: "Color gradient with a grid and floating dust",
  },
  {
    value: "flowing-gradient",
    label: "Flowing gradient",
    description: "Multi-hue RGB wave of soft color blooms",
  },
  {
    value: "lightspeed",
    label: "Lightspeed",
    description: "Subtle tunnel of light streaks",
  },
  {
    value: "galaxy",
    label: "Galaxy",
    description: "Slow-rotating starfield with soft nebula clouds",
  },
];

/**
 * New (preview) effects, shown in their own "New" group. `reworks` names
 * the existing effect one replaces, if it is a rework.
 */
export const NEW_BACKGROUND_EFFECT_OPTIONS: {
  value: BackgroundEffect;
  label: string;
  description: string;
  reworks?: BackgroundEffect;
}[] = [
  {
    value: "northern-lights",
    label: "Northern lights",
    description: "Curtains of light rippling across the sky",
  },
  {
    value: "silk",
    label: "Silk",
    description: "Slow folds of satin with a sheen along each crest",
  },
  {
    value: "mesh-gradient",
    label: "Mesh gradient",
    description: "Colors drifting and blending, smooth and banding-free",
    reworks: "flowing-gradient",
  },
  {
    value: "spiral-galaxy",
    label: "Spiral galaxy",
    description: "Two arms of stars wheeling round a bright core",
    reworks: "galaxy",
  },
  {
    value: "plexus",
    label: "Plexus",
    description: "A linked cloud turning in 3D, with signals running through",
    reworks: "constellation",
  },
  {
    value: "firefly-sync",
    label: "Firefly sync",
    description: "Fireflies that drift, then slowly fall into step",
    reworks: "fireflies",
  },
  {
    value: "snowfall",
    label: "Snowfall",
    description: "Snow in three depths, moved by one gusting wind",
    reworks: "snow",
  },
  {
    value: "contours",
    label: "Contours",
    description: "Survey-map lines over land that slowly reshapes",
  },
  {
    value: "projector",
    label: "Projector",
    description: "A projector beam from above, dust glinting in the light",
  },
  {
    value: "film",
    label: "Film",
    description: "Grain at 24 fps, gate flicker, dust and the odd scratch",
    reworks: "grain",
  },
  {
    value: "halftone",
    label: "Halftone",
    description: "A dot screen swelling and shrinking with a slow wave",
  },
];

type EffectFactory = (canvas: HTMLCanvasElement) => EffectController;

const FACTORIES: Partial<Record<BackgroundEffect, EffectFactory>> = {
  rain: createRainEffect,
  constellation: createConstellationEffect,
  "perlin-flow": createPerlinFlowEffect,
  matrix: createMatrixEffect,
  snow: createSnowEffect,
  fireflies: createFirefliesEffect,
  dust: createDustEffect,
  bokeh: createBokehEffect,
  "warp-grid": createWarpGridEffect,
  scanlines: createScanlinesEffect,
  grain: createGrainEffect,
  "modern-grid": createModernGridEffect,
  lightspeed: createLightspeedEffect,
  galaxy: createGalaxyEffect,
  "spiral-galaxy": createSpiralGalaxyEffect,
  plexus: createPlexusEffect,
  "firefly-sync": createFireflySyncEffect,
  snowfall: createSnowfallEffect,
  contours: createContoursEffect,
  projector: createProjectorEffect,
  film: createFilmEffect,
  halftone: createHalftoneEffect,
};

let flowingPresetGetter: (() => FlowingGradientPreset) | null = null;

export function setFlowingGradientPresetGetter(
  getter: (() => FlowingGradientPreset) | null
) {
  flowingPresetGetter = getter;
}

/**
 * Start effect `id` on `canvas`. `shaders: false` runs a shader effect's 2D
 * stand-in (Flowing gradient) straight away: the caller passes it after an
 * earlier start returned SHADER_FAILED, on a fresh canvas.
 */
export function createBackgroundEffect(
  id: BackgroundEffect,
  canvas: HTMLCanvasElement,
  shaders = true
): EffectController | null | typeof SHADER_FAILED {
  const preset = () => flowingPresetGetter?.() ?? "theme";
  if (id === "flowing-gradient") {
    return createFlowingGradientEffect(canvas, preset);
  }
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
  if (id === "custom-image" || id === "none") return null;
  const factory = FACTORIES[id];
  if (!factory) return null;
  return factory(canvas);
}
