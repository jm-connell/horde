# 0019. YouTube history comes from Takeout and is kept apart from Horde's own

Status: Accepted

## Context

Users want what they watched on YouTube to count in Horde: marked as watched on channel pages and taken into account by recommendations. The YouTube Data API has not exposed watch history since 2016. yt-dlp can list the history feed with the account's cookies, but that means sending logged-in requests for listing traffic, which Horde avoids on purpose (`ytdlp_common.COOKIE_RETRY_KINDS`: cookies only for age or members gates) because it puts the account at risk; the feed also has no timestamps and only reaches back so far. Google Takeout exports the full history with a timestamp per view, plus subscriptions and playlists, as the user's own file.

Horde's history (`user_video_state`) is keyed by library video and feeds History, Continue watching, resume positions and retention rules. Most videos watched on YouTube are not in the library.

## Decision

- **Takeout upload, per account.** `POST /api/takeout/import` reads the export (zip parts or loose files; `services/takeout/parse.py`) and stores each view in `youtube_watch_events` (migration `0020_youtube_watch_events`) under the uploading account, keyed by YouTube id. Subscriptions and playlists are only listed back; `POST /api/takeout/apply` follows and copies the ones the user ticks, as that user's follows and private playlists.
- **One row per view, unique on (user, video, time watched).** Re-importing a newer export that overlaps an earlier one adds only the new views (`INSERT ... ON CONFLICT DO NOTHING`); counting views per video is what makes rewatch counts possible.
- **Kept apart from `user_video_state`.** The views never touch History, Continue watching, resume or retention. Readers opt in: For you (`recommend.py`), the channel feed endpoints (`youtube_watched`), the Download page's rewatched list and, behind a per-account switch, the History stats.
- **Views, never time.** Takeout does not say how long a video played, so the stats count YouTube views toward videos, days, channels and the weekday × hour grid, and never toward watch time.
- **Recency first.** A channel's pull from YouTube views halves every 30 days, so taste follows what the user watches now. Throwbacks bring back channels watched a lot 6+ months ago, one pick in twenty, moved up only, drawn once per user and day so paging sees one order.

## Consequences

- The history is as fresh as the last export; there is no background sync.
- The throwback draw changes at midnight UTC, so a shelf paged across it can see one reshuffle.
- HTML exports (Takeout's default) are parsed best-effort: dates are localised, so only English dates are reliable; a view whose time zone is unknown is left out (and counted) rather than filed hours off. Times are stored to the second so JSON and HTML imports of one view match.
- Parsing happens in memory, so the import caps what it reads (160 MB of history, 16 MB per CSV, 320 MB in all, no member packed more than 100:1). Views are inserted in chunks, each committed, so a big import never holds SQLite's write lock for long.
- Playlists from Takeout carry only video ids; titles come from what Horde already knows (library, channel index, the history), else the entry has none until downloaded.
- For you folds the history in SQL (views per channel and day, per month past six months) and keeps the result per user in `ctx.caches` until the history changes or ten minutes pass; the first request after an import of a very large history takes about a second.
- Imported views outlive the videos and are deleted with the account or by **Forget**; a factory reset keeps them (they belong to accounts, which a reset keeps).
