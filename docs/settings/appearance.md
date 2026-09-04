# Appearance

Controls under **Settings → Appearance** (`?tab=appearance`). Most of these keys sync through the server [`ui` blob](index.md#three-layer-persistence); see [All settings](all-settings.md).

## Themes

Built-in `data-theme` values (plus **Custom**):

| Value | Label |
|-------|--------|
| `default` | Default (cyan) |
| `oled` | OLED (true black) |
| `terminal` | Terminal (green) |
| `nord` | Nord |
| `light` | Minimal Neutrals + Teal (light) |
| `indigo` | Midnight Indigo |
| `cyber` | Neon Cyber |
| `sunset` | Warm Sunset |
| `forest` | Forest Deep |
| `slate` | Slate Minimal |
| `earthy` | Earthy Modern (light) |
| `frozen` | Frozen Blue Minimal (light) |
| `mocha` | Soft Mocha & Sage (light) |
| `custom` | Custom |

**Default:** `default`.

### Custom colors

When theme is `custom`, `customColors` supplies:

| Field | Default | Notes |
|-------|---------|--------|
| `accent` | `#22d3ee` | Accent / interactive chrome |
| `background` | `#08090c` | Page background |

### Saved custom theme presets

**Save current** snapshots appearance-related fields into `customThemes` (name up to 64 characters). Applying a preset restores theme colors, **custom CSS**, background effect knobs, nav/hover/loading chrome, font size, and UI font.

!!! note "Cap"
    At most **40** presets. Extra entries are dropped on normalize (`customThemes.slice(0, 40)`).

## Custom CSS

**Custom CSS** is off by default. Turn on **Enable custom CSS** to show the editor and inject the stylesheet as `#horde-custom-css` after built-in theme styles. Capped at **64 000** characters; synced in the `ui` blob (`customCss`, `customCssEnabled`). Turning the toggle off leaves the CSS in place but stops injecting it.

Prefer CSS variables (`--accent`, `--ink-950` …) and stable hooks (`html[data-page]`, `[data-horde="nav"]`, `.ui-card`) over scraping every Tailwind class. When enabled, Settings shows a collapsed selector list; the full catalog is [Custom CSS](custom-css.md).

A generated “HTML element wiki” is intentionally **not** shipped — component markup changes often, so DevTools is the source of truth for one-off selectors.

## Fonts

### Built-in typefaces (`uiFont`)

| Id | Label |
|----|--------|
| `default` | Inter (default) |
| `jetbrains-mono` | JetBrains Mono |
| `roboto` | Roboto |
| `source-code-pro` | Source Code Pro |
| `ubuntu` | Ubuntu |
| `space-grotesk` | Space Grotesk |
| `ibm-plex-sans` | IBM Plex Sans |
| `inconsolata` | Inconsolata |
| `oxanium` | Oxanium |
| `source-sans-3` | Source Sans 3 |
| `electrolize` | Electrolize |
| `custom` | Add custom… (transient while adding) |

Google Fonts families load via CSS link when selected. Permanently saved customs live in `customFonts` (URL or uploaded file) and are selected by their saved id.

### Font size (`fontSize`)

| Value | Root scale |
|-------|------------|
| `small` | 0.9× (14.4 px base) |
| `medium` | 1× (16 px) — **default** |
| `large` | 1.125× |
| `xl` | 1.25× |

Applied as `documentElement` font-size. Legacy `uiScale` percentages migrate into these four steps.

## Background effects

`backgroundEffect` options:

| Value | Description |
|-------|-------------|
| `none` | Solid theme background (**default**) |
| `custom-image` | Uploaded still or animated background |
| `rain` | Falling rain streaks |
| `constellation` | Drifting linked stars |
| `perlin-flow` | Particles in a noise field |
| `matrix` | Cascading glyph rain |
| `snow` | Gentle drifting flakes |
| `fireflies` | Glowing wandering lights |
| `dust` | Rising motes |
| `bokeh` | Soft out-of-focus orbs |
| `warp-grid` | Grid distorted by noise |
| `scanlines` | CRT-style line sweep |
| `grain` | Subtle animated film grain |
| `modern-grid` | Gradient + grid + floating dust |
| `flowing-gradient` | Multi-hue soft color blooms |
| `lightspeed` | Tunnel of light streaks |
| `galaxy` | Slow-rotating starfield / nebula |

### Flowing gradient presets

When effect is `flowing-gradient`, `flowingGradientPreset`:

| Value | Label |
|-------|--------|
| `theme` | Theme default (**default**) |
| `rgb` | RGB wave |
| `cool` | Cool |
| `warm` | Warm |
| `mono` | Mono accent |

### Custom image controls

| Key | Default | Range / notes |
|-----|---------|----------------|
| `customBackgroundId` | `null` | Server-stored background asset id |
| `customBackgroundMime` | `null` | MIME of that asset |
| `customBackgroundBlur` | `12` | 0–40 px |
| `customBackgroundTint` | `#08090c` | Hex tint color |
| `customBackgroundTintOpacity` | `0.45` | 0–1 |

**Extract palette** samples accent candidates from the custom image.

### Effect intensity knobs

| Key | Default | Range |
|-----|---------|--------|
| `backgroundOpacity` | `0.45` | 0.1–1 |
| `backgroundEffectSpeed` | `1` | 0.25–3 |
| `backgroundEffectSize` | `1` | 0.5–2 |
| `backgroundEffectColorMode` | `accent` | `accent` \| `custom` |
| `backgroundEffectColor` | `#22d3ee` | Hex when mode is `custom` |

### Pause while watching

`pauseBackgroundWhileWatching` (**default `false`**) stops animated backgrounds during playback to save GPU/CPU.

## Interface chrome

### Nav indicator (`navIndicator`)

| Value | Behavior |
|-------|----------|
| `none` | Static active state only |
| `liquid` | Jelly pill that morphs between items (**default**) |
| `underline` | Sliding accent bar |
| `fade` | Soft pill that eases between items |

Legacy boolean `liquidNav` migrates to `liquid` / `none`.

### Hover motion (`hoverMotion`)

| Value | Behavior |
|-------|----------|
| `off` | No hover motion |
| `subtle` | Light lift and brightness (**default**) |
| `lift` | Cards rise with soft shadow |
| `glow` | Accent glow around hovered surfaces |

### Panel transparency

Sliders are always visible. First install defaults to **50%** transparency and **50%** blur. Existing installs that had the old “Translucent panels” toggle **off** migrate to 0% / 0% (opaque).

| Key | Default | Notes |
|-----|---------|--------|
| `translucentPanelStrength` | `0.5` | 0–1 (higher = more see-through; 0% is fully opaque) |
| `translucentPanelBlur` | `0.5` | 0–1 (higher = stronger backdrop blur on `.ui-panel` / `.ui-card`) |
| `translucentPanelTintEnabled` | `false` | Mix a color into panel fills |
| `translucentPanelTint` | `#ffffff` | Hex color used when tint is on |
| `translucentPanelTintStrength` | `0.35` | 0–1 mix toward the tint color |
| `translucentPanelLegibility` | `true` | Raise opacity on `.ui-panel-legible` panels |

Legacy `translucentPanels` (bool) is still read: `false` → both sliders 0%; `true` keeps the saved strength and converts the old coupled blur.

### Loading style (`loadingStyle`)

Settings shows a looping preview of each option instead of a text label.

| Value | Notes |
|-------|--------|
| `dots` | **Default** — bouncing beads |
| `spinner` | Classic rotating ring |
| `bar` | Indeterminate sweep |
| `orbit` | Satellite around a core |
| `pulse` | Expanding sonar rings |
| `wave` | Equalizer bars |
| `comet` | Sweeping tail |
| `tiles` | Staggered squares |
| `petal` | Blooming ring of beads |
| `blob` | Morphing glow |
| `atom` | Electrons on tilted orbital rings |
| `cube` | Wireframe cube on every axis |
| `helix` | Double strand |
| `spiral` | Beads funneling inward |
| `swarm` | Fireflies on tangled paths |
| `leapfrog` | Beads hopping over each other |
| `plus` | Arms fold in, then the plus turns |
| `split` | Expanding grid; outer tiles step around |
| `ringwalk` | Pentagon stepping on a spinning ring |
| `newton` | Five-bead cradle |
| `bouncebox` | Two beads ricocheting in a frame |
| `pong` | A paddle batting a bouncing ball |
| `goo` | Gooey dots cycling around a plus |

## See also

- [Settings overview](index.md)
- [Custom CSS](custom-css.md) — user stylesheet and stable selectors
- [All settings](all-settings.md#ui-blob-keys-server_ui_keys)
- [Playback](playback.md) — watch-page content (not chrome)
