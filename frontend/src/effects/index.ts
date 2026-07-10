import type { BackgroundEffect } from "../hooks/useSettings";
import type { EffectController } from "./shared";
import { createAuroraEffect } from "./aurora";
import { createBokehEffect } from "./bokeh";
import { createConstellationEffect } from "./constellation";
import { createDustEffect } from "./dust";
import { createFirefliesEffect } from "./fireflies";
import { createFlowingGradientEffect } from "./flowingGradient";
import { createGrainEffect } from "./grain";
import { createLightspeedEffect } from "./lightspeed";
import { createMatrixEffect } from "./matrix";
import { createModernGridEffect } from "./modernGrid";
import { createPerlinFlowEffect } from "./perlinFlow";
import { createRainEffect } from "./rain";
import { createScanlinesEffect } from "./scanlines";
import { createSnowEffect } from "./snow";
import { createWarpGridEffect } from "./warpGrid";

export const BACKGROUND_EFFECT_OPTIONS: {
  value: BackgroundEffect;
  label: string;
  description: string;
}[] = [
  { value: "none", label: "None", description: "Solid theme background" },
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
  { value: "aurora", label: "Aurora", description: "Soft drifting color blooms" },
  { value: "matrix", label: "Matrix", description: "Cascading glyph rain" },
  { value: "snow", label: "Snow", description: "Gentle drifting flakes" },
  { value: "fireflies", label: "Fireflies", description: "Glowing wandering lights" },
  { value: "dust", label: "Dust", description: "Rising motes in the air" },
  { value: "bokeh", label: "Bokeh", description: "Soft out-of-focus orbs" },
  {
    value: "warp-grid",
    label: "Warp grid",
    description: "A grid gently distorted by noise",
  },
  { value: "scanlines", label: "Scanlines", description: "CRT-style line sweep" },
  { value: "grain", label: "Film grain", description: "Subtle animated noise" },
  {
    value: "modern-grid",
    label: "Modern grid",
    description: "Color gradient with a grid and floating dust",
  },
  {
    value: "flowing-gradient",
    label: "Flowing gradient",
    description: "Soft drifting color blooms",
  },
  {
    value: "lightspeed",
    label: "Lightspeed",
    description: "Subtle tunnel of light streaks",
  },
];

type EffectFactory = (canvas: HTMLCanvasElement) => EffectController;

const FACTORIES: Partial<Record<BackgroundEffect, EffectFactory>> = {
  rain: createRainEffect,
  constellation: createConstellationEffect,
  "perlin-flow": createPerlinFlowEffect,
  aurora: createAuroraEffect,
  matrix: createMatrixEffect,
  snow: createSnowEffect,
  fireflies: createFirefliesEffect,
  dust: createDustEffect,
  bokeh: createBokehEffect,
  "warp-grid": createWarpGridEffect,
  scanlines: createScanlinesEffect,
  grain: createGrainEffect,
  "modern-grid": createModernGridEffect,
  "flowing-gradient": createFlowingGradientEffect,
  lightspeed: createLightspeedEffect,
};

export function createBackgroundEffect(
  id: BackgroundEffect,
  canvas: HTMLCanvasElement
): EffectController | null {
  const factory = FACTORIES[id];
  if (!factory) return null;
  return factory(canvas);
}
