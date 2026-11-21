# Appearance cleanup: design

## Intent

The Appearance tab grew a "New" preview section beside the established
pickers, so backgrounds and loaders are listed twice, with overlap, and every
background shows the same sliders whether or not they do anything. Make it one
list of each, with controls that fit the selected background, and a tab that
is easier to navigate.

## Goals

- One Background picker: None and Custom image first, then these 14,
  alphabetical: Constellation, Contours, Dust, Lightspeed, Matrix, Mesh
  gradient, Modern grid, Northern lights, Rain, Scanlines, Silk, Snowfall,
  Spiral galaxy, Warp grid.
- Each background shows only the controls that apply to it, including
  controls unique to it.
- One loader list of 13: Spinner (the Arc animation), Orbit, Helix, Infinity,
  Sweep, Spokes, Dots, Pulse, Wave, Cube, Spiral, Swarm, Leapfrog.
- Nav indicators: None, Liquid, Underline, Fade, Dot, Focus. Hover motions:
  Off, Subtle, Lift, Glow.
- Fix the Modern grid jump; rewrite Rain so it is smooth; steady Spokes;
  polish Leapfrog; improve any other effect or loader where a clean
  improvement is visible.
- Tab order: Theme, Text, Background, Motion (nav indicator, hover, loading),
  Panels, Tab bar, Custom CSS, with a jump row at the top.

## Non-goals

- No change to themes, fonts, the tab bar or custom CSS beyond their place in
  the layout.
- No backend change: the `ui` blob is free-form.

## Anti-goals

- Nobody may end up on a blank or broken background or loader after the
  update: every removed value, in settings and in saved custom themes, maps to
  a kept one.

## Approaches

1. Keep the "New" section and prune both lists. Rejected: the duplication is
   the complaint.
2. One list per kind, driven by a per-effect control table (chosen). The
   table names which shared controls (intensity, speed, size, color, palette)
   and which extra sliders each background has; the section renders from it.
3. A separate settings component per background. Rejected: 14 near-identical
   components for what is a table.

## Decisions

- Removed values migrate on load: snow -> snowfall, galaxy -> spiral-galaxy,
  flowing-gradient -> mesh-gradient, plexus -> constellation, other removed
  backgrounds -> none; spinner and arc -> spinner (drawn as Arc), bar ->
  sweep, other removed loaders -> dots; stretch -> underline; tilt and zoom
  -> subtle.
- Flowing gradient stays in the code only as the stand-in for the three
  shader effects where WebGL is unavailable.
- Extra per-background sliders are stored in one `backgroundEffectOptions`
  map keyed by effect, so adding one needs no new settings key.

## Left to the builder

The exact extra sliders per effect, settled while reviewing each one in the
browser.
