# Live chat beside the player in theater and fit window

Worked out in conversation on 2026-11-27. Builds on chat replay and live chat
(`2026-11-21-chat-replay-design.md`, `2026-11-21-live-chat-design.md`). Calls
marked *(builder's call)* were not asked for by the user.

## Why

In theater the chat sits under the video, beside the description, so reading
it means scrolling away from the picture. Fit window covers the page, so the
chat is gone. The user wants the chat next to the video in both, and a way to
open it from the player.

## Goals

- Theater and fit window, on a window at least 1024px wide: the chat (live or
  replay) sits to the right of the picture, as tall as the player.
- Collapsed, a small arrow at the top right of the picture opens it (user's
  decision: an arrow there, not a button in the bottom control row).

## Non-goals

- Standard view (the chat already tops the column beside the player).
- Desktop fullscreen, which stays video only. *(builder's call: asked, not
  answered; one condition in the player if wanted later)*
- Phones and windows under 1024px: as today. Touch fullscreen keeps the chat
  where it was, but it is the same panel as in theater, so it takes the same
  look there (a flush column with an arrow, not an inset card). *(builder's
  call, after the user's "like Twitch")*
- A second "collapsed" state: the arrow and the panel's **Hide** are the
  `showChatReplay` setting.

## Approaches

1. **The player's own slot beside the picture** (chosen). The player already
   keeps an empty element beside the picture in touch fullscreen and the watch
   page portals the chat into it. Offer the same slot in theater and fit
   window. One mechanism for every "chat beside the picture" case, and the
   only one that reaches fit window, where the player covers the page.
2. Lay it out from the page (a column beside the dock). Works for theater
   only; fit window would need a second mechanism to narrow the fixed player.
   Rejected.

## Design

- **Player.** `VideoPlayer` offers the slot (`data-horde="player-aside"`) when
  not mini and either in touch fullscreen (as now) or, outside fullscreen, in
  theater or fit window on a window of 1024px or more. The rule and the
  threshold live in one module both the player and the watch page use. The
  slot is `min(24rem, 33%)` of the player wide *(builder's call: a share of
  the player, not the window, so a docked Ask panel narrows it too)*, and its
  content is positioned inside it so a long chat never makes the player
  taller than the picture. Empty, it takes no room.
- **Arrow.** The page hands the player an opener (`label`, `open`) through
  `PlaybackActions`; the player draws a left arrow at the top right of the
  picture while its slot is offered and an opener is set, shown and hidden
  with the other controls. The player knows nothing about chat.
- **Watch page.** `chatPlacement` returns `beside-player` in place of
  `beside-info` (theater, and now fit window). Shown: the panel goes into the
  player's slot and nowhere on the page. Hidden: the opener is set, and in
  theater a **Show live chat** bar sits first in the column under the video.
  The column beside the description goes back to holding only the queue.
- **Names.** `fullscreenAside` / `onFullscreenAside` become `playerAside` /
  `onAside`; the panel variant `fullscreen` becomes `beside-player`;
  `beside-info` is removed.

## Checks

- `model.test.ts`: `chatPlacement` for theater, fit window and a narrow window.
- Playwright (`chat-replay.spec.ts`): theater and fit window put the chat
  beside the picture at the player's height; Hide gives the picture the width
  back and the arrow reopens it; the narrow-window and fullscreen tests keep
  passing.
- `DESIGN.md`, `docs/guides/watching.md` and `CHANGELOG.md` updated.
