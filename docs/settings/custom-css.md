# Custom CSS

Horde can inject **arbitrary CSS** over the running UI, similar to Jellyfin’s custom CSS box. The editor is hidden until you turn on **Enable custom CSS** under **Settings → Appearance → Custom CSS** (`?tab=appearance`). Edits apply immediately, persist in the server [`ui` blob](index.md#three-layer-persistence) as `customCss` / `custom_css` plus `customCssEnabled` / `custom_css_enabled`, and are included when you **Save theme**.

## Why not an HTML element wiki?

A page that lists every DOM node, Tailwind class, and React wrapper would **rot** on the next layout tweak. Class names like `bg-ink-900` exist because Tailwind generated them for this build; they are not a public API.

Instead Horde documents a **small stable surface**:

| Kind | Examples |
|------|----------|
| CSS variables | `--accent`, `--ink-950` … `--ink-600` |
| Page hook | `html[data-page="watch"]` |
| Theme hook | `html[data-theme="oled"]` |
| Landmark hooks | `[data-horde="nav"]`, `[data-horde="video-card"]` |
| Semantic classes | `.ui-panel`, `.ui-card`, `.ui-interactive`, `.page-shell` |

For one-off targeting, **inspect the running page** (browser DevTools). That is always accurate; a scraped HTML catalog is not.

When enabled, Settings includes a collapsed **Selector reference** next to the CSS box so you do not have to leave the app for the common hooks.

## How injection works

1. Boot reads `horde.settings`. If custom CSS is enabled, it writes a `<style id="horde-custom-css">` in `<head>` **before first paint**.
2. Edits update that tag as you type (same 300 ms server debounce as other UI keys).
3. Empty CSS, or **Enable custom CSS** off, removes the tag. The source stays saved when the toggle is off.
4. The stylesheet comes **after** built-in theme CSS, so your rules win at equal specificity. Raise specificity or use `!important` only when a built-in rule already does.

Cap: **64 000** characters. `</style` sequences are neutralized so the payload cannot break out of the style tag.

!!! warning "You can hide the UI"
    Custom CSS runs as the admin of this [no-auth](../design/no-auth.md) instance. A rule like `* { display: none }` will hide Settings too. Turn **Enable custom CSS** off if you can still reach Settings, clear the box, or remove `custom_css` from `app_settings.json` → `ui` and refresh.

## CSS variables

Colors are **space-separated RGB** (no commas) so Tailwind utilities can do `rgb(var(--accent) / 0.5)`.

```css
:root {
  --ink-950: 8 9 12;      /* page background */
  --ink-900: 13 15 20;    /* panels / cards */
  --ink-800: 20 23 31;
  --ink-700: 28 33 43;    /* borders */
  --ink-600: 42 49 63;
  --accent: 34 211 238;
  --accent-soft: 103 232 249;
  --accent-deep: 8 145 178;
  --font-sans: Inter, system-ui, sans-serif;
}
```

When translucent panels are on, `--ui-panel-alpha` and `--ui-panel-blur` also apply.

## `data-page` values

Set on `<html>` from the current route:

| `data-page` | Route |
|-------------|--------|
| `home` | `/` |
| `watch` | `/watch`, `/watch/:id` |
| `settings` | `/settings` |
| `history` | `/history` |
| `download` | `/download` |
| `import` | `/import` (and legacy `/review`) |
| `playlists` | `/playlists` |
| `playlist` | `/playlists/:id` |
| `other` | anything else |

Example: hide the top bar only while watching:

```css
html[data-page="watch"] [data-horde="nav"] {
  background: transparent;
}
```

## Landmark `data-horde` attributes

| Attribute | Element |
|-----------|---------|
| `nav` | Top navigation `<header>` |
| `main` | Centered page `<main>` |
| `sidebar` | Library channel sidebar rail |
| `channel-list` | Channel list inside the sidebar |
| `background` | Background effect canvas or custom image |
| `video-card` | Library video card |
| `feed-card` | Channel-feed card |
| `custom-css` | The injected `<style>` tag itself |

Semantic classes already used by motion/transparency: `.ui-panel`, `.ui-panel-legible`, `.ui-card`, `.ui-interactive`, `.page-shell`, `.horde-scrollbar`.

## Examples

Warm accent over any built-in palette:

```css
:root {
  --accent: 255 120 40;
  --accent-soft: 255 170 110;
  --accent-deep: 200 80 20;
}
```

Rounder library cards:

```css
[data-horde="video-card"],
[data-horde="feed-card"] {
  border-radius: 1.25rem;
}
```

`@import` is allowed if you want to pull a hosted stylesheet or extra `@font-face`. Remote URLs depend on this browser reaching that host.

## Saved themes

**Save theme** snapshots `customCss` and `customCssEnabled` with colors, background, font, and chrome. Applying a preset restores that CSS and the enable flag. Snapshots saved before these fields existed have empty CSS (and will **clear** the box when applied); a snapshot with CSS but no enable flag is treated as enabled.

## See also

- [Appearance](appearance.md) — palettes, fonts, backgrounds
- [All settings](all-settings.md#ui-blob-keys-server_ui_keys)
- [Settings overview](index.md)
