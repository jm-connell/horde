# 0015. Watch time is counted from progress saves, stored per UTC hour, and outlives the video

Status: Accepted

## Context

The History stats (time watched, streaks, top channels, a weekday × hour chart) need to know how long each user watched, and `user_video_state` only knows where each user is in each video. There is no playback event stream: the player saves the position about every 5 seconds (`PATCH /api/videos/{id}/progress`), saves 0 from 90% on, reports the finish, and devices that were offline send their saves late with the time they were made. Users live in time zones the server may not share (containers often run in UTC). Videos are deleted, trashed and restored.

## Decision

- **Count from the saves.** Each save adds `new position - previous position` when that is above 0 and no more than twice the wall-clock time since the previous save plus 3 seconds (`services/watch_stats.py`). Playing counts (content seconds, up to 2× speed), seeks either way do not. For live saves the gap is capped at 75 seconds: the player saves every 5 seconds while playing and at once on resuming, so a longer gap is a pause, and a seek right after it must not count as the paused time. The previous save's raw position is remembered in memory on the `AppContext` (a bounded LRU, `WatchRefs`, read and written under one lock so two tabs cannot count the same seconds twice), because the stored position is 0 from 90% on; after a restart the stored position and `last_watched_at` are the reference. A 0 save after a position above 0 keeps the reference position and banks the capped time since the previous save, so the finish can count the tail after 90% for as long as it can have played. A save queued offline is the only one left of its session (the device keeps the newest per video), so its gap is not capped; it counts in the hour it was made, and not at all when `record_progress` drops it as older than what was saved since.
- **Store per user, video and UTC hour** (`user_watch_time`, migration `0015_user_watch_time`): seconds plus the number of finishes. The stats endpoint takes the browser's IANA zone and folds the hours into local days and weekday × hour cells in Python, so days and streaks follow the viewer's clock whatever the server's zone. An hour row per video stays small (thousands of rows per user per year); one request reads every hour row of the user once and runs four small aggregate queries (about 20 ms for 5,000 rows).
- **History outlives the video.** `video_id` is `ON DELETE SET NULL` and the row keeps a copy of the channel name, so deleting a video keeps the user's totals and top channels (the current channel name wins while the video exists, so a rename follows). The trash snapshot records the row ids and a restore links them to the video again. Deleting an account deletes its rows; a factory reset that erases the library clears them with `user_video_state`.

## Consequences

- No backfill: watch time before the release is unknown, so the charts start empty. "Videos started" unions the new rows with `user_video_state` so older history still counts there; "videos finished" counts explicit finishes, recorded from this release on.
- The counter is an estimate: two devices playing the same video at once, or playback faster than 2×, count less than was watched; a short skip (a few seconds) between two saves counts as watched; an offline session cannot tell playing from seeking.
- Hours are UTC hours, so in zones with a half- or quarter-hour offset each hour is filed under the local hour it starts in.
- Rows of deleted videos have no video, so they count toward time and channels but not toward distinct videos or tags.
