# Keyboard shortcuts

Player shortcuts are handled globally while the full player is active. They mirror common YouTube-style bindings.

## Shortcuts

| Key | Action |
|-----|--------|
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
    Shortcuts are ignored when focus is in an `INPUT`, `TEXTAREA`, or `SELECT` so you can type titles, notes, and search queries normally.

## Tips

- ++space++ calls `preventDefault` so the page does not scroll while toggling play
- Caption cycling with ++c++ works with ++shift++ equally (`C`)
- ++n++ only runs when the current video has parsed chapters and jumps to the next chapter start after the playhead

Day-to-day player behavior: [Video player](../guides/player.md) and [Watching](../guides/watching.md).
