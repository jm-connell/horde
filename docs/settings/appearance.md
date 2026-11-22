# Appearance

Controls under **Settings → Appearance** (`?tab=appearance`). The tab runs Theme, Font, Background, Motion, Panels, Tab bar and Custom CSS, with a row of buttons at the top that jump to each section. Most of these keys sync through the server [`ui` blob](index.md#three-layer-persistence); see [All settings](all-settings.md).

You can change a great deal about how Horde looks without knowing how to code: everything on this page is a control in Settings, and for anything it does not cover you can describe the change to [Ask](../guides/ai-features.md#custom-css), which writes the [custom CSS](custom-css.md) for you and previews it first.

## Themes

Built-in `data-theme` values (plus **Custom**). The palette dropdown lists the dark palettes first, then the light ones, then Custom.

| Value | Label | Group |
|-------|--------|-------|
| `default` | Default (cyan) | Dark |
| `oled` | OLED (true black) | Dark |
| `terminal` | Terminal (green) | Dark |
| `nord` | Nord | Dark |
| `indigo` | Midnight Indigo | Dark |
| `cyber` | Neon Cyber | Dark |
| `sunset` | Warm Sunset | Dark |
| `forest` | Forest Deep | Dark |
| `slate` | Slate Minimal | Dark |
| `light` | Minimal Neutrals + Teal | Light |
| `earthy` | Earthy Modern | Light |
| `frozen` | Frozen Blue Minimal | Light |
| `mocha` | Soft Mocha & Sage | Light |
| `custom` | Custom | Custom |

**Default:** `default`.

### Custom colors

When theme is `custom`, `customColors` supplies:

| Field | Default | Notes |
|-------|---------|--------|
| `accent` | `#22d3ee` | Accent / interactive chrome |
| `background` | `#08090c` | Page background |

### Saved custom theme presets

With the **Custom** palette selected, **Save theme** snapshots appearance-related fields into `customThemes` (name up to 64 characters). Applying a preset restores theme colors, **custom CSS**, background effect knobs, nav/hover/loading chrome, font size, and UI font.

!!! note "Cap"
    At most **40** presets. Extra entries are dropped on normalize (`customThemes.slice(0, 40)`).

## Fonts

### Built-in typefaces (`uiFont`)

| Id | Label |
|----|--------|
| `default` | Inter |
| `jetbrains-mono` | JetBrains Mono |
| `roboto` | Roboto |
| `source-code-pro` | Source Code Pro |
| `ubuntu` | Ubuntu |
| `space-grotesk` | Space Grotesk |
| `ibm-plex-sans` | IBM Plex Sans |
| `inconsolata` | Inconsolata |
| `oxanium` | Oxanium (**default**) |
| `source-sans-3` | Source Sans 3 |
| `electrolize` | Electrolize |
| `custom` | Add custom… (transient while adding) |

Oxanium, the default, ships with Horde (`@fontsource/oxanium`, SIL Open Font License) and loads from your server. The other Google Fonts families load from Google via a CSS link only when selected. Permanently saved customs live in `customFonts` (URL or uploaded file) and are selected by their saved id. Uploading a font file (and deleting one from the server) is for administrators; members add Google Fonts by URL or name, and removing a font only takes it off their own list.

### Font size (`fontSize`)

| Value | Root scale |
|-------|------------|
| `small` | 0.9× (14.4 px base) |
| `medium` | 1× (16 px) — **default** |
| `large` | 1.125× |
| `xl` | 1.25× |

Applied as `documentElement` font-size. Legacy `uiScale` percentages migrate into these four steps.

## Background effects

One picker, **Background animation**: None and Custom image first, then the animations by name. `backgroundEffect` options:

| Value | Description |
|-------|-------------|
| `none` | Solid theme background (**default**) |
| `custom-image` | Uploaded still or animated background (administrators upload, delete and extract palettes; anyone picks one of the uploaded images) |
| `constellation` | Drifting linked stars |
| `contours` | Survey-map contour lines over land that slowly reshapes |
| `dust` | Rising motes |
| `lightspeed` | Tunnel of light streaks |
| `matrix` | Cascading glyph rain |
| `mesh-gradient` | Five drifting colors blended per pixel, dithered so dark ramps do not band (shader) |
| `modern-grid` | Gradient, a drifting grid and floating dust |
| `northern-lights` | Curtains of light with a bright hem and rising rays; faint stars on dark themes (shader) |
| `rain` | Soft rain in three depths, slanted by the wind |
| `scanlines` | CRT-style lines with a slow sweep |
| `silk` | Slow folds of satin with a sheen along each crest (shader) |
| `snowfall` | Snow in three depths moved by one gusting wind |
| `spiral-galaxy` | A tilted galaxy whose arms keep their shape as it turns |
| `warp-grid` | Grid distorted by noise |

The three shader effects run on the GPU (WebGL). Where the browser has no WebGL, warns that WebGL would be slow (as some do on a virtual machine or remote desktop, where it runs on the CPU), or cannot start the shader, a plain 2D gradient in the same palette runs in their place.

Effects that were removed move to the closest one that is left the next time settings load, in saved custom themes too: `snow` → `snowfall`, `galaxy` → `spiral-galaxy`, `flowing-gradient` → `mesh-gradient`, `plexus` → `constellation`; `perlin-flow`, `fireflies`, `firefly-sync`, `bokeh`, `grain`, `film`, `projector` and `halftone` → `none`.

### Controls per background

Settings shows only the controls the selected background uses. Every animation has **Intensity**, **Speed**, **Size** and **Color**; where Size means something more specific, the slider is named for it. Each also has at most one slider of its own, stored under `backgroundEffectOptions.<effect>.<key>`:

| Effect | Size slider is | Own slider (`key`) | Range | Default |
|--------|----------------|--------------------|-------|---------|
| `constellation` | Size | Link distance (`linkDistance`) | 0.5–2× | 1× |
| `contours` | Size | Line spacing (`spacing`) | 0.5–2× | 1× |
| `dust` | Size | | | |
| `lightspeed` | Density | Streak length (`length`) | 0.5–3× | 1× |
| `matrix` | Size | Trail length (`trail`) | 0.5–2× | 1× |
| `mesh-gradient` | Size | Softness (`softness`) | 0–100% | 50% |
| `modern-grid` | Grid size | Dust (`dust`) | 0–2× | 1× |
| `northern-lights` | Size | Height (`height`) | 20–80% | 50% |
| `rain` | Density | Angle (`angle`) | −45–45° | 12° |
| `scanlines` | Line spacing | Sweep (`sweep`) | 0–100% | 50% |
| `silk` | Size | Sheen (`sheen`) | 0–100% | 60% |
| `snowfall` | Size | Wind (`wind`) | 0–3× | 1× |
| `spiral-galaxy` | Size | Tilt (`tilt`) | 0–80° | 63° |
| `warp-grid` | Grid size | Warp (`warp`) | 0–2× | 1× |

Each background keeps its own slider values, so switching away and back restores them. A saved custom theme stores the sliders of its own background only, and applying it leaves the other backgrounds' values alone. Values outside the range are clamped, and unknown effects or keys are dropped, when settings load.

### Mesh gradient palette

When the effect is `mesh-gradient`, `flowingGradientPreset` picks its colors:

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

### Shared effect controls

| Key | Default | Range |
|-----|---------|--------|
| `backgroundOpacity` | `0.45` | 0.1–1 |
| `backgroundEffectSpeed` | `1` | 0.25–3 |
| `backgroundEffectSize` | `1` | 0.5–2 |
| `backgroundEffectColorMode` | `accent` | `accent` \| `custom` |
| `backgroundEffectColor` | `#22d3ee` | Hex when mode is `custom` |

### Pause background animation during playback

`pauseBackgroundWhileWatching` (**default `false`**) stops animated backgrounds during playback to save GPU/CPU. Fit-window and fullscreen playback pause the animation either way, since it is hidden; standard and theater keep it running unless this is on.

## Motion

### Nav indicator (`navIndicator`)

| Value | Behavior |
|-------|----------|
| `none` | Static active state only |
| `liquid` | Liquid pill: the edge nearest the clicked item flows ahead and the pill thins as it stretches, then the trailing edge follows and settles |
| `underline` | Sliding accent bar (**default**) |
| `fade` | Soft pill that eases between items |
| `dot` | A dot that stretches along its way, then squashes and settles under the item |
| `focus` | Viewfinder corners that glide over, land a little wide and lock on |

Legacy boolean `liquidNav` migrates to `liquid` / `none`; the removed `stretch` becomes `underline`.

### Hover motion (`hoverMotion`)

| Value | Behavior |
|-------|----------|
| `off` | No hover motion |
| `subtle` | Light lift and brightness (**default**) |
| `lift` | Cards rise with soft shadow |
| `glow` | Accent glow around hovered surfaces |

Hover motion only shows on devices with a mouse or trackpad, so a tap on a phone does not leave a card lifted. When the system asks for reduced motion, hover motion and button press feedback are off whatever this setting says; pages, cards and thumbnails still fade in, without moving. The removed `tilt` and `zoom` become `subtle`.

### Loading animation (`loadingStyle`)

Settings shows a looping preview of each option instead of a text label. Under reduced motion every loader holds still and breathes instead.

| Value | Notes |
|-------|--------|
| `spinner` | An arc that grows and shrinks as it turns |
| `orbit` | Two moons circling a planet in real 3D |
| `helix` | A double strand twisting in place |
| `infinity` | A comet looping a figure eight |
| `sweep` | Two segments racing along a track |
| `spokes` | Fading spokes ticking round |
| `dots` | **Default.** Bouncing beads |
| `pulse` | Expanding sonar rings |
| `wave` | Equalizer bars |
| `cube` | Wireframe cube on every axis |
| `spiral` | Beads funneling inward |
| `swarm` | Fireflies on tangled paths |
| `leapfrog` | Beads leaping over each other |

Loaders that were removed move to a kept one when settings load: `arc` → `spinner` (the same animation, renamed), `bar` → `sweep`, and `comet`, `tiles`, `petal`, `plus`, `ringwalk`, `cradle`, `clapper` and `play` → `dots`.

## Panels

The phone status bar and installed-app title bar take the theme's page background color.


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

## Top bar (`navBarItems`)

On a wider screen, the bar at the top of every page links to Home, Playlists, Subscriptions, History, Offline, Download, Import and Settings. **Top bar** chooses which of these it shows and in what order: move a page earlier or later, remove it, or add it back from the list below. **Reset** puts back every page in the default order. The choice is saved with your account, so it is the same on every device you sign in on.

**Settings** cannot be removed (nothing else in a wide bar leads to it); the **HORDE** logo goes home whether or not **Home** is shown. A page this account cannot use (Download and Import need the download permission), or one that needs the server while Horde is offline, is left out, and **Offline** shows only when this device has offline downloads or is offline. Whether the bar or the **☰** menu shows is decided by whether *every* page's link would fit, not just the chosen ones, so a phone (in either orientation) and a narrow window always get the menu, which lists every page whatever is chosen here.

## Tab bar (`tabBarItems`)

On a phone, the installed app (added to the Home Screen) shows a floating bar of tabs at the bottom of the screen. **Tab bar** chooses which tabs it shows and in what order (up to 5): move a tab earlier or later, remove it, or add one from the list below. **Reset** puts back the default.

| Tab | Does |
|-----|------|
| Home | **Default.** The home page; tapping it again goes back to the top |
| Search | **Default.** Opens the search box at the top |
| Download | **Default.** The Download page (needs the download permission) |
| Ask | **Default.** Opens [Ask](../guides/ask.md) (when AI is set up for this account) |
| Playlists, History, Settings | Those pages |
| Offline | The Offline page, when this device has offline downloads |

A tab this account cannot use, or one that needs the server while Horde is offline, is left out of the bar. The bar follows the panel transparency, blur and tint above, but not the legibility boost. A browser tab has no tab bar.

## Custom CSS

**Custom CSS** is off by default. Turn on **Enable custom CSS** to show the editor and inject the stylesheet as `#horde-custom-css` after built-in theme styles. Capped at **64 000** characters; synced in the `ui` blob (`customCss`, `customCssEnabled`). Turning the toggle off leaves the CSS in place but stops injecting it.

Prefer CSS variables (`--accent`, `--ink-950` …) and stable hooks (`html[data-page]`, `[data-horde="nav"]`, `.ui-card`) over scraping every Tailwind class. When enabled, Settings shows a collapsed selector list; the full catalog is [Custom CSS](custom-css.md).

A generated “HTML element wiki” is intentionally **not** shipped — component markup changes often, so DevTools is the source of truth for one-off selectors.

## See also

- [Settings overview](index.md)
- [Custom CSS](custom-css.md) — user stylesheet and stable selectors
- [All settings](all-settings.md#ui-blob-keys-server_ui_keys)
- [Playback](playback.md) — watch-page content (not chrome)
