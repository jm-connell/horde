# Keyboard shortcuts

Player shortcuts are handled globally while the full player is active. They mirror common YouTube-style bindings. Every key below except ++escape++ can be rebound under **Settings → Playback → Hotkeys**; the table lists the defaults.

## Shortcuts

| Key | Action |
|-----|--------|
| ++slash++ | Focus the search bar (any page) |
| ++space++ or ++k++ | Play / pause |
| ++c++ | Cycle captions / subtitle track |
| ++t++ | Toggle theater mode |
| ++f++ | Toggle windowed fullscreen (in-page) |
| ++escape++ | Exit windowed mode (when currently windowed) |
| ++arrow-right++ | Seek forward 5 seconds |
| ++arrow-left++ | Seek backward 5 seconds |
| ++arrow-up++ | Volume up (~5%) |
| ++arrow-down++ | Volume down (~5%) |
| `&gt;` or `.` | Increase playback speed one step |
| `&lt;` or `,` | Decrease playback speed one step |
| ++n++ | Seek to next chapter (when chapters exist) |

!!! note "Mini player"
    These shortcuts are **disabled while the mini player is active** so typing and browsing are not hijacked. Expand back to the Watch page (or docked player) for hotkeys. See [Player architecture](../design/player-architecture.md).

!!! note "Form fields"
    Shortcuts are ignored when focus is in an `INPUT`, `TEXTAREA`, `SELECT` or any `contenteditable` element so you can type titles, notes, and search queries normally. They are also ignored when ++ctrl++, ++alt++ or ++cmd++ is held, and ++space++ / the arrow keys are left to a focused button, menu item or slider.

!!! tip "Turn single-character hotkeys off"
    **Settings → Playback → Hotkeys → Single-character hotkeys** disables the letter, punctuation and ++space++ shortcuts (WCAG 2.1.4), for example when speech-input software types into the page. Arrow keys and ++escape++ keep working. The choice is stored with the other playback preferences.

## Menus and dialogs

Menus (video actions, stream quality, download quality, bulk playlist picker) open with ++enter++ or ++space++ on their button. ++arrow-down++ / ++arrow-up++, ++home++ and ++end++ move between items, ++escape++ closes the menu and returns focus to its button, and ++tab++ closes it. Dialogs keep ++tab++ inside them, close on ++escape++ and give focus back to where you were.

## Tips

- ++space++ calls `preventDefault` so the page does not scroll while toggling play
- Caption cycling with ++c++ works with ++shift++ equally (`C`)
- ++n++ only runs when the current video has parsed chapters and jumps to the next chapter start after the playhead

Day-to-day player behavior: [Video player](../guides/player.md) and [Watching](../guides/watching.md).
