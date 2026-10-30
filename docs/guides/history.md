# History & continue watching

!!! info "History is per account"
    Resume positions, **History** and **Continue watching** belong to the signed-in user (table `user_video_state`); other people using the same Horde do not see or change yours. When accounts were introduced, the existing history moved to the first administrator. Expiry (`progress_expiry_days`) applies to everyone's positions.

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

## Stats

A band at the top of History sums up your own watching (other accounts never see it, and you never see theirs):

| Tile | What it counts |
|------|----------------|
| **Watched this week** | Time spent watching in the last 7 days, with the change against the 7 days before |
| **Videos finished** | Videos you played to the end in the last 30 days |
| **Streak** | Days in a row with any watching, up to today (a streak that ended yesterday still counts until today is over) |
| **Top channel** | The channel you watched most in the last 30 days |

Beside them, a strip shows each of the last 30 days. Click the band (or press Enter on it) for **More stats**; Horde remembers whether you left it open. The details have their own period (7 days, 30 days, a year or all time) and show:

- **Watch time** per day (per week for a year, per month past two years). Hover a bar, or focus the chart and use the arrow keys, to read a day.
- **Top channels** by watch time; click one to open it.
- **When you watch**: a weekday × hour grid, darker where you watched more.
- **Top tags** of what you watched, and the **library** for context: how many videos, their size, how many were added in the period and what share of the library you have opened.
- A line with the period's total, active days, videos started and your best day.

### How watch time is counted

Every position save (about every 5 seconds while playing) adds how far the position moved since the previous save, but only when it moved forward by no more than twice the time that passed plus 3 seconds. Playing counts (at 2× speed it counts the video's seconds, so an hour of a 2× video is an hour); seeking forward or back does not, and neither does a seek after a pause (only the last 75 seconds of a gap between saves count as time that could have played). The last stretch after 90%, where the player saves 0, is counted when the video ends. A device that was offline sends its newest position per video with the time it was reached; the whole stretch counts, in the hour it was reached, unless you saved something newer elsewhere first.

The time is kept per hour in UTC (table `user_watch_time`) and the page asks for it in your browser's time zone, so "today", streaks and the weekday × hour grid follow your clock, not the server's. In zones whose offset is not a whole number of hours (India, Nepal, parts of Australia), each hour of watching is filed under the local hour it starts in, so the grid and the day boundary are off by that half or quarter hour.

!!! note "Starts counting with this version"
    Watch time was never recorded before Horde 1.1, so the charts start empty after the upgrade. **Videos started** also counts your older History, and **Videos finished** counts finishes from this version on.

Deleting a video keeps the time you spent on it (it still counts toward your totals and its channel); restoring it from the trash links it to the video again. Deleting an account deletes its watch time, and a factory reset that erases the library clears it with the rest of the history.

API: `GET /api/history/stats?range=7d|30d|365d|all&tz=<IANA zone>` (the signed-in account only; without `tz` the server's zone is used).

### YouTube views in the stats

If you [imported your YouTube history](youtube-history.md), **Include YouTube in History stats** (Settings → Library → YouTube history, remembered per account) adds those views to videos started, active days, the streak, top channels and the weekday × hour grid. They never add watch time: Takeout does not record how long a video played. The History list itself never shows them. API: `include_youtube=true`.

## Continue watching

### Where it appears

- **Library home** — a **Continue watching** row above the main grid
- Not shown on the **Recommended** tab
- Not shown on **channel** pages

### Who qualifies

Roughly: videos with a saved resume position for you that still look in-progress (enough watched to matter, and not past the finished threshold). The list is also limited by the continue-watching time window (below).

Clicking a card opens `/watch/:id` and seeks to the saved position.

## How progress works

| Rule | Value |
|------|--------|
| Field | `last_position_sec` on the video |
| Save cadence | About every **5 seconds** while playing; the position you paused or sought to within 5 seconds; at once when the page is hidden or closed |
| Finished | At **≥ 90%** of duration, progress is **cleared** (next open starts at 0) and the time is recorded as `finished_at` (watching it again clears it); a channel's [retention rule](channels.md#retention) uses it |
| History stamp | `last_watched_at` updates as you watch |
| Late saves | A position queued on a device while the server was unreachable is sent with the time it was reached, and only applies if you have saved nothing newer since on any device |

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
- [ADR 0015](../adr/0015-watch-time-per-hour.md) — why watch time is stored per hour and outlives the video
- [Video player](player.md) — playback controls
- [Library settings](../settings/library.md) — `progress_expiry_days`
- [Playback settings](../settings/playback.md) — related / autoplay while watching
