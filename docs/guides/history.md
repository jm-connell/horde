# History & continue watching

Horde tracks what you’ve watched and where you left off so you can jump back without scanning the whole library.

## History page (`/history`)

The History page lists videos with watch activity:

| Behavior | Detail |
|----------|--------|
| Filter | `watched_only` — videos that have been watched |
| Sort | `last_watched_at` descending (most recent first) |
| Grouping | **By calendar day** — Today, Yesterday, then weekday / month / day labels |
| Cards | Open the [watch](watching.md) page; progress overlays show leftover position when present |

Times are interpreted as UTC when the API returns naive timestamps, then shown in your local timezone for day buckets and clock labels.

## Continue watching

### Where it appears

- **Library home** — a **Continue watching** row above the main grid
- Not shown on the **Recommended** tab
- Not shown on **channel** pages

### Who qualifies

Roughly: videos with a saved `last_position_sec` that still look in-progress (enough watched to matter, and not past the finished threshold). The list is also limited by the continue-watching time window (below).

Clicking a card opens `/watch/:id` and seeks to the saved position.

## How progress works

| Rule | Value |
|------|--------|
| Field | `last_position_sec` on the video |
| Save cadence | About every **5 seconds** while playing |
| Finished | At **≥ 90%** of duration, progress is **cleared** (next open starts at 0) |
| History stamp | `last_watched_at` updates as you watch |

Full watch-page behavior (related, autoplay, stream handoff) is in [Watching](watching.md).

## Two different clocks

These are easy to confuse — they do different jobs:

| Knob | Default | Configurable? | Role |
|------|---------|----------------|------|
| `progress_expiry_days` | **14** | **Yes** — app / library settings (typically 1–365) | Clears **stale** saved positions so abandoned half-watches expire |
| `continue_watching_days` | **7** | **No** — fixed backend constant (`CONTINUE_WATCHING_DAYS`) | Limits which in-progress videos appear in the **continue watching** query |

!!! note "Not a settings toggle"
    The 7-day continue-watching window is **not** user-configurable in the Settings UI. Only `progress_expiry_days` is exposed for operators to tune.

### Practical effect

- After **~7 days** without qualifying activity, a video may drop off the continue-watching row even if a position still exists.
- After **`progress_expiry_days`** (default 14), Horde clears old `last_position_sec` values entirely during expiry maintenance.

Set expiry under [Settings → Library](../settings/library.md) (or the app settings field wired there).

## Related

- [Library](library.md) — continue watching row on home
- [Watching](watching.md) — resume, 5s saves, 90% clear
- [Video player](player.md) — playback controls
- [Library settings](../settings/library.md) — `progress_expiry_days`
- [Playback settings](../settings/playback.md) — related / autoplay while watching
