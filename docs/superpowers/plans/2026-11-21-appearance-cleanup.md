# Appearance Cleanup Implementation Plan

**Goal:** One background list, one loader list, per-background controls, and a clearer Appearance tab.

**Architecture:** A per-effect control table (`frontend/src/effects/controls.ts`) says which shared controls and which extra sliders each background has; Settings renders from it and the effect loop hands the values to each effect as `frame.options`. Removed option values are mapped to kept ones when settings load.

**Tech Stack:** React 18, TypeScript, Vite, Tailwind, canvas 2D / WebGL, vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-21-appearance-cleanup-design.md`

## Global Constraints

- Kept backgrounds: `none`, `custom-image`, `constellation`, `contours`, `dust`, `lightspeed`, `matrix`, `mesh-gradient`, `modern-grid`, `northern-lights`, `rain`, `scanlines`, `silk`, `snowfall`, `spiral-galaxy`, `warp-grid`.
- Kept loaders (stored values): `spinner` (drawn as the old Arc), `orbit`, `helix`, `infinity`, `sweep`, `spokes`, `dots`, `pulse`, `wave`, `cube`, `spiral`, `swarm`, `leapfrog`. Default `dots`.
- Nav indicators: `none`, `liquid`, `underline`, `fade`, `dot`, `focus`. Hover: `off`, `subtle`, `lift`, `glow`.
- Follow `CLAUDE.md`: surgical changes, no silent excepts, eslint/prettier/tsc clean, reduced motion respected.

## Review Focus

- A stored removed background, loader, nav indicator or hover value (also inside a saved custom theme): loads as its mapped kept value, never blank.
- `backgroundEffectOptions` with junk (non-number, out of range, unknown effect or key): clamped or dropped.
- No hardware WebGL: the three shader effects still fall back to the 2D flowing gradient.
- Reduced motion: loaders hold still and breathe; no background animates.
- Size or option slider dragged while an effect runs: no restart flash, no particle pile-up.

## Task 1: Effects (files under `frontend/src/effects/` only)

**Produces:**

```ts
// effects/shared.ts
interface EffectFrame { /* existing */ options: Record<string, number> }
interface EffectController { /* existing */ setOptions(options: Record<string, number>): void }

// effects/controls.ts
export interface EffectSlider {
  key: string; label: string; min: number; max: number; step: number;
  default: number; format: "x" | "percent" | "deg";
}
export interface EffectControls {
  speed: boolean; size: boolean; color: boolean; palette: boolean;
  /** What Size means here when "Size" is misleading, e.g. "Density". */
  sizeLabel?: string;
  sliders: EffectSlider[];
}
export type AnimatedEffect = Exclude<BackgroundEffect, "none" | "custom-image">;
export const EFFECT_CONTROLS: Record<AnimatedEffect, EffectControls>;
/** Defaults for `effect`, overlaid with the valid, clamped numbers in `stored`. */
export function effectOptions(effect: AnimatedEffect, stored: unknown): Record<string, number>;

// effects/index.ts
export const BACKGROUND_EFFECT_OPTIONS: { value; label; description }[]; // None, Custom image, then the 14 by label A-Z
// NEW_BACKGROUND_EFFECT_OPTIONS is removed.
```

- [ ] Delete the removed effects' files and factories (bokeh, film, fireflies, fireflySync, galaxy, grain, halftone, perlinFlow, plexus, projector, snow) and anything only they used. Keep `flowingGradient.ts` as the shader stand-in only.
- [ ] Add `options` to the frame and `setOptions` to the loop (2D and WebGL); `createBackgroundEffect` seeds the defaults.
- [ ] Modern grid: one wrap per axis (`(time*8) % spacing` and `(time*4.8) % spacing` separately) so the horizontal lines no longer snap.
- [ ] Rain: rewrite for smooth motion: 60 fps, slower fall, streaks longer than a frame's travel, gradient tails, three depth layers; sliders `angle` and density.
- [ ] Review each of the 14: set `speed/size/color/palette` truthfully (Size must do something visible or be `false`), add sliders unique to the effect where they earn their place, and make clean improvements.
- [ ] Tests in `effects/effects.test.ts`: every kept effect has an `EFFECT_CONTROLS` entry; `effectOptions` clamps, drops junk and fills defaults; options list is alphabetical after the first two.
- [ ] `npx vitest run src/effects`, `npx eslint src/effects`, `npx prettier --check src/effects` pass.

## Task 2: Loaders (`frontend/src/loadingStyles.ts`, `components/LoadingIndicator.tsx`, loader rules in `index.css`)

**Produces:**

```ts
export const LOADING_STYLES: readonly [...13 values];
export const LOADING_STYLE_OPTIONS: { value; label; description }[]; // order: Spinner, Orbit, Helix, Infinity, Sweep, Spokes, Dots, Pulse, Wave, Cube, Spiral, Swarm, Leapfrog
/** Map any stored value to a kept one: arc -> spinner, bar -> sweep, other removed or unknown -> dots. */
export function normalizeLoadingStyle(value: unknown): LoadingStyle;
// NEW_LOADING_STYLE_OPTIONS is removed; LOADING_STYLE_SEARCH_KEYWORDS and isLoadingStyle stay.
```

- [ ] Remove bar, comet, tiles, petal, plus, ringwalk, cradle, clapper, play and the old ring spinner (marks, CSS, keyframes). `spinner` draws the Arc mark.
- [ ] Spokes: the ring must not shift during the cycle (centre fixed, whole-pixel geometry, rotation about the exact centre).
- [ ] Leapfrog: polish (eased arcs, squash and stretch on take-off and landing, pads reacting).
- [ ] Clean improvements to the others; all 13 animate only `transform`/`opacity` where practical and breathe under reduced motion.
- [ ] Vitest for `normalizeLoadingStyle`; eslint and prettier pass on the touched files.

## Task 3: Settings model (`hooks/settings/*`)

- [ ] Trim `BackgroundEffect`, `HoverMotion`, `NavIndicator` unions; add `backgroundEffectOptions: Record<string, Record<string, number>>` (default `{}`, synced, in custom theme presets).
- [ ] `migrations.ts`: map removed values (spec, Decisions) in settings and presets; normalize options through `effectOptions`.
- [ ] Tests in `migrations.test.ts` for each mapping and for junk options.

## Task 4: Settings UI (`pages/settings/*`, `components/BackgroundEffect.tsx`)

- [ ] `BackgroundEffect.tsx` pushes `effectOptions(effect, settings.backgroundEffectOptions[effect])` to the controller.
- [ ] `BackgroundSection` renders from `EFFECT_CONTROLS`; delete `NewSection`.
- [ ] Split Interface into Motion and Panels; add the jump row; order Theme, Text, Background, Motion, Panels, Tab bar, Custom CSS.
- [ ] Remove `stretch`, `tilt`, `zoom` options and their CSS/JS.
- [ ] Update `search.ts`, e2e specs, `docs/settings/*`, `DESIGN.md` if it lists these, `help_catalog.json`.

## Task 5: Verify

- [ ] Each background and loader checked in the browser; `scripts/check.sh --e2e`.
