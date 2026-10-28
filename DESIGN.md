---
name: Horde
description: A self-hosted video archive that feels like a home screening room.
# Color and font values below are the DEFAULT theme only. Each user can pick
# another theme, custom colors, custom CSS, a different font and font size, so
# what is normative is the role (ink-950, accent, text-muted, the --font-sans
# hook), never the literal value. Radius, spacing, type scale and motion are
# fixed across themes.
colors:
  ink-950: "#08090c"
  ink-900: "#0d0f14"
  ink-800: "#14171f"
  ink-700: "#1c212b"
  ink-600: "#2a313f"
  accent: "#22d3ee"
  accent-soft: "#67e8f9"
  accent-deep: "#0891b2"
  on-accent: "#08090c"
  text-strong: "#f3f4f6"
  text-body: "#e5e7eb"
  text-secondary: "#d1d5db"
  text-muted: "#878a91"
  danger: "#f87171"
  warning: "#fbbf24"
typography:
  page-title:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 600
  section-label:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 600
    letterSpacing: "0.025em"
  body:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
  label:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 500
rounded:
  sm: "4px"
  md: "6px"
  lg: "8px"
  xl: "12px"
  full: "9999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.lg}"
    padding: "6px 12px"
  button-primary-hover:
    backgroundColor: "{colors.accent-soft}"
  button-secondary:
    backgroundColor: "{colors.ink-800}"
    textColor: "{colors.text-body}"
    rounded: "{rounded.lg}"
    padding: "6px 12px"
  panel:
    backgroundColor: "{colors.ink-900}"
    rounded: "{rounded.xl}"
    padding: "16px"
  video-card:
    backgroundColor: "{colors.ink-900}"
    rounded: "{rounded.xl}"
  chip:
    backgroundColor: "{colors.ink-800}"
    textColor: "{colors.text-secondary}"
    rounded: "{rounded.full}"
    padding: "2px 10px"
  menu:
    backgroundColor: "{colors.ink-900}"
    rounded: "{rounded.lg}"
---

# Design System: Horde

## Overview

**Creative North Star: "The Home Screening Room"**

Horde is the room where the household's archive is shown. The lights are low,
the picture is the brightest thing on screen, and everything else (navigation,
controls, panels) sits back in near-black layers until it is needed. One accent
color marks what is live, selected or actionable; it is never decoration.

It is an app people operate every day, so the system favours precision over
atmosphere: dense but calm lists and grids, small type, consistent spacing,
fast quiet motion. Personality comes from the details (the liquid nav pill, the
card rise, the translucent panels over an optional animated background) and from
the user's own choices. Every user can re-theme Horde, change its font and size,
and add custom CSS, so the system is defined in roles, not fixed colors.

**What is fixed and what is not.** Colors and the font family are user
choices: the values in this file are the default theme, shown so the roles have
something concrete to point at. Design against the roles. What does not change
between users is the structure: which role each element uses, the type scale in
`rem` (it scales with the user's font size), radius, spacing, elevation and
motion.

**Key Characteristics:**
- Dark, layered "ink" surfaces with a single accent per theme.
- Thumbnails and the player carry the color; chrome stays neutral.
- Small, dense type (mostly 12–14px) with clear weight steps.
- Rounded but not soft: 8px controls, 12px panels and cards, pills for chips.
- Quick motion on one curve; nothing waits on an animation.

## Colors

A five-step neutral ink scale plus one accent with a soft and a deep variant.
Values above are the default theme; every theme redefines the same roles as RGB
triples on `:root` / `[data-theme]` in `frontend/src/index.css`, and Tailwind
reads them through `@theme inline` (`bg-ink-900`, `text-accent`, `text-muted`).

### Primary
- **Screening Cyan** (#22d3ee, `accent`): the active nav item, selected
  states, primary buttons, progress fills, focus rings, live and "new"
  markers.
- **On Accent** (`on-accent`, `text-on-accent`): text and icons on an accent
  fill. Dark themes, and earthy (whose accent is a dark brown), use the page
  color; light, frozen and mocha use a dark ink; custom themes pick whichever
  reads better. Never use `text-ink-950` on an
  accent fill: on light themes it is near-white.
- **Lit Cyan** (#67e8f9, `accent-soft`): hover state of accent buttons and
  links.
- **Deep Cyan** (#0891b2, `accent-deep`): pressed or low-emphasis accent.

### Neutral
- **Projection Black** (#08090c, `ink-950`): page background and header. Also
  the phone status bar color.
- **Seat Row** (#0d0f14, `ink-900`): panels, cards, menus.
- **Aisle** (#14171f, `ink-800`): secondary buttons, inputs, hovered rows, chips.
- **Rail** (#1c212b, `ink-700`): borders, rings, dividers, progress tracks.
- **Usher** (#2a313f, `ink-600`): hovered borders, strongest neutral.
- **Text**: `gray-100` (#f3f4f6) for headings and titles, `gray-200` (#e5e7eb)
  for body, `gray-300` for secondary, `text-muted` (#878a91, theme-tuned) for
  metadata.
- **Status**: red-400 for failures and destructive actions, amber-400/300 for
  waiting, held and warning states.

### Named Rules
**The Theme Role Rule.** Use the role tokens (`ink-*`, `accent*`, `text-muted`),
never raw hex or Tailwind palette colors for surfaces and accents. A color that
only looks right on the default theme is a bug on the other twelve.

**The Muted Contrast Rule.** Secondary text uses `text-muted`, which is tuned per
theme to 4.5:1. Do not reach for `text-gray-500/600`.

**The One Accent Rule.** The accent marks state and the primary action. If a
screen has more than a few accent elements, something is decoration.

## Typography

**Body Font:** whatever the user picks, through `--font-sans` (`font-sans`).
Inter (with system-ui, sans-serif) is the default; there are 11 presets plus
custom Google Fonts, monospace and display faces among them. Never name a font
family in a component. Root size is per user too (16px default, scaled by the
font size setting), so size in `rem` and let layouts tolerate wider glyphs.

**Character:** One family, small sizes, hierarchy by weight and color rather
than by big type.

### Hierarchy
- **Page title** (600, 1.25rem; 1.5rem bold on a few top-level pages):
  one per page, `text-gray-100`.
- **Section label** (600, 0.75rem, uppercase, wide tracking, `text-gray-400`):
  panel headers such as "Up next" and "Continue watching".
- **Title** (500, 0.875rem): card and row titles, clamped to two lines.
- **Body** (400, 0.875rem): descriptions, settings copy.
- **Label / meta** (400–500, 0.75rem, `text-muted`): channel, date, size,
  duration badges (tabular numbers).

### Named Rules
**The Small Type Rule.** Body copy is 14px and metadata 12px; anything smaller
(10–11px) is reserved for badges over thumbnails. Text fields stay at 16px or
more on touch screens so iOS does not zoom.

## Layout

Single-column app shell under a fixed translucent header. Pages sit in a centred
container with a 16px gutter on phones, wider on desktop; settings and forms cap
at `max-w-2xl`, the library grid and watch page use the full width. The library
is a responsive card grid with an optional channel sidebar; the watch page puts
the player first with metadata and a related-videos sidebar beside it on wide
screens and below it on narrow ones. Spacing is a 4px rhythm, mostly 8px
(`gap-2`) inside components and 12–16px between them; panels pad 16–20px.

Theater mode widens the player to the viewport; the mini player docks bottom
right and the play queue docks beside it. A quiet footer (centred
`text-muted` links, one secondary-style "Ask about Horde" button) closes every
page: pinned to the bottom of short pages, set off by an `ink-800` hairline. Respect `env(safe-area-inset-*)` for
the header and anything fixed to an edge.

## Elevation & Depth

Depth is tonal first: page `ink-950`, panels and cards `ink-900` with a 1px
`ink-700` ring, raised controls `ink-800`. With panel transparency on (the
default), panels and cards become translucent with a backdrop blur over the
optional animated background, so layering reads as glass rather than shadow.
Shadows appear only on floating layers (menus, dialogs, the mini player and
docked queue: `shadow-lg` to `shadow-2xl`) and as a response to hover when the
user's hover motion setting asks for it (lift shadow or accent glow).

### Named Rules
**The Flat-At-Rest Rule.** Surfaces in the page flow carry no shadow at rest.
Shadow means "floating above the page" or "responding to you".

## Shapes

Rounded rectangles throughout. Controls and rows `rounded-lg` (8px), panels and
cards `rounded-xl` (12px), thumbnails inside a card follow the card, small
badges `rounded-sm`, chips, toggles and progress bars `rounded-full`. Borders
are 1px rings in `ink-700`; selection and focus use the accent (2px outline or a
1px accent ring), not thicker borders.

## Components

- **Buttons.** Primary: accent fill, `on-accent` text, semibold, `accent-soft` on
  hover. Secondary: `ink-800` fill, `gray-200` text, `ink-700` on hover. Quiet:
  text only, `text-muted` to `accent` on hover. All pressables scale to 0.97 on
  press (80ms) when the button press setting is on, and get `ui-interactive` for
  the user's hover motion.
- **Video card.** Thumbnail with duration badge and a thin accent progress bar
  for watched position; title (two lines), channel and meta below. "+ Queue"
  appears on hover or focus and confirms with a check and "Queued". Cards rise in on mount
  with a short stagger.
- **Download job card.** Panel with title, status, thumbnail, progress and
  actions. Cards in Active downloads carry an accent bar on the outline: 4px
  down the left edge, fading out a few pixels into the rounded corners (a
  masked overlay span in `DownloadJobCard`). This is intentional and owner-approved: it marks a
  download in progress at a glance. Keep it even though impeccable's
  side-tab rule flags it.
- **Panels.** `ui-panel` sections with a section label header, optional
  collapse (the `Collapse` component, grid-rows 0fr→1fr) and a rotating arrow.
- **Rows and lists.** 4–8px padding, `hover:bg-ink-800`, drag handle on the left
  when reorderable, quiet remove button on the right.
- **Inputs and selects.** `ink-800` fill, `ink-700` ring, accent focus ring;
  `ThemedSelect` for custom option lists.
- **Menus and dialogs.** `ui-menu` / `MenuFlyout` drop from their trigger in
  150ms; dialogs centre. Both trap focus and close on Escape.
- **Floating panels.** The Ask about Horde chat is a non-modal floating
  panel (`ink-900`, `rounded-xl`, `ring-ink-600`, `shadow-2xl`, `z-45`: above
  the mini player, below toasts and dialogs): it opens in the bottom-right corner (above or beside the mini
  player when that is there), drags by its header, resizes from its top-left
  corner like the mini player, and becomes a bottom sheet on phones. Escape
  closes it while focus is inside; the page behind stays usable.
- **Progress.** Full-width fill moved with `translateX`, linear, on an `ink-700`
  or `ink-800` track; accent for downloads, sky for background jobs, red on
  failure.

### Motion
One curve, `ease-fluid` (`cubic-bezier(0.22, 1, 0.36, 1)`, a strong ease-out),
for anything entering, expanding or moving. Durations: press 80ms, hover and
small toggles 150–200ms, menus 150ms, panels and collapses 200–300ms, nothing in
routine UI over 300ms. Progress is linear. Animate `transform` and `opacity`;
new list items enter with `@starting-style` (Tailwind `starting:`). Hover motion
only applies under `(hover: hover) and (pointer: fine)`. Under reduced motion,
fades stay and movement goes.

## Do's and Don'ts

**Do**
- Use role tokens and check new UI on at least the default, light and OLED
  themes.
- Keep the accent for state and the one primary action on a view.
- Use `text-muted` for secondary text and `tabular-nums` for changing numbers.
- Give every new animation a purpose (feedback, continuity, state) and keep it
  under 300ms on `ease-fluid`.
- Acknowledge every action on screen (a state change, a toast or an entering
  item), even when the result lands somewhere else.

**Don't**
- Hard-code hex colors, Tailwind palette grays for surfaces, or a second accent.
- Add shadows to in-flow surfaces, gradient text, or decorative glow.
- Animate `width`, `height`, `top` or `left` on anything that repeats or runs
  during playback.
- Animate keyboard-initiated actions or anything users trigger many times a
  minute.
- Use text glyphs (✕ ▼ ✓ ▶) for icons; they change with the user's font. Use
  the inline SVG icons in `frontend/src/components/icons.tsx` (1em,
  `currentColor`, decorative), and keep the name on the button.
