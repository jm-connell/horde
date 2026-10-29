# Library

Controls under **Settings → Library** (`?tab=library`). Display and download prefs mostly sync via the [`ui` blob](index.md#three-layer-persistence); progress expiry, channel catalog, and metadata interval are **top-level** app settings.

## Display

### Continue watching & cards

| Setting | Key | Default | Storage |
|---------|-----|---------|---------|
| Show continue watching | `showContinueWatching` | `true` | UI blob |
| Progress bar on continue watching | `showProgressOnContinueWatching` | `true` | UI blob |
| Progress bar on all library videos | `showProgressOnAllVideos` | `false` | UI blob |
| Show dates on video cards | `showCardDates` | `true` | UI blob |

### Live streams

| Setting | Key | Default | Storage |
|---------|-----|---------|---------|
| Show live streams | `showLiveStreams` | `true` | UI blob |

**Followed channels** (below the toggle) lists the channels you follow, with **Unfollow**, and takes a channel URL or `@handle` to follow a channel that has no videos on the server. Follows are per user. See [Channels → Following and live streams](../guides/channels.md#following-and-live-streams).

### Progress expiry

| Setting | Key | Default | Range | Storage |
|---------|-----|---------|-------|---------|
| Progress expiry (days) | `progress_expiry_days` | `14` | 1–365 | Top-level `app_settings.json` (mirrored locally as `progressExpiryDays`) |

Saved watch position resets after this many days of **inactivity**. Server-wide: shown to administrators only.

!!! warning "`continue_watching_days` is backend-only"
    The continue watching **row** hides videos after **7 days**. That value is `continue_watching_days` in server `DEFAULTS` — fixed at 7, **not** editable in the UI, and not part of the client settings object. Do not confuse it with progress expiry.

### Default video sort

`defaultLibrarySort` (**default `added_at`**) is used when you open the library or after a temporary sort expires (3 hours in `horde.library-sort`).

| Value | Label |
|-------|--------|
| `added_at` | Recently added |
| `published_at` | Publish date |
| `title` | Title |
| `duration` | Duration |
| `file_size` | File size |
| `view_count` | View count |

(`random` exists as a live sort option but is not offered as the Settings default.)

### Channel list order (sidebar)

| Key | Default | Values |
|-----|---------|--------|
| `channelSort` | `recent_download` | `recent_download` \| `video_count` \| `alphabetical` \| `subscriber_count` |
| `channelOrder` | `desc` | `asc` \| `desc` |

## Downloads

Formerly the separate Downloads settings tab (legacy `?tab=downloads` → Library). The section is shown to accounts with the `download` permission (every administrator); the two personal rows below are per user.

| Setting | Key | Default | Notes |
|---------|-----|---------|--------|
| Show active download count in navigation | `showDownloadNavBadge` | `true` | Badge on Download while jobs are queued/running |
| Normalize volume on download | `normalizeVolumeOnDownload` | `true` | Loudness normalization via ffmpeg on new downloads |
| Playback compatibility | `downloadVideoCodec` | `"av1"` | `av1` \| `h264_native` \| `h264_convert` \| `sidecar` (server key `download_video_codec`). Stamped onto every new download as `video_codec`. Legacy `h264` / `h265` migrate to `h264_convert`. |
| H.264 copy resolution | `compatCopyResolution` | `"1080p"` | `1080p` \| `source` (server key `compat_copy_resolution`). Short-side cap for H.264 copies: 1080 or full size up to 4K. See [copy resolution](../guides/downloads.md#how-the-sidecar-works). |

The **Playback compatibility** panel (both rows above and the library actions below) is server-wide and shown to administrators only. New downloads use this server-wide choice, so members never see the panel; the API refuses a member's change to `download_video_codec` or `compat_copy_resolution` with 403 `admin_required`, and `GET /api/compat/summary` is for administrators.

The four modes, in the order the picker shows them:

- **AV1 only** (default): YouTube's AV1/VP9, copied. Smallest files, no encode, newest devices only. A device that cannot play a video can still get a one-off H.264 copy from the player.
- **H.264 only, up to 1080p** (`h264_native`): YouTube's own H.264. Every video preset is capped at 1080p, so 1440p/4K downloads are saved at 1080p. No conversion.
- **H.264 only, full resolution** (`h264_convert`): native H.264 up to 1080p; 1440p/4K download AV1, then are re-encoded to H.264 at source resolution and replace the original. Heavy; a GPU is strongly advised.
- **AV1 + H.264 copy** (`sidecar`): keeps the AV1 original and saves a ≤1080p H.264 copy beside it. For YouTube downloads the copy is YouTube's own H.264 (an extra download, not an encode); imports, existing videos, and videos without YouTube H.264 are encoded locally.

Each card shows **Storage** and **Server work** pills. Above the cards, Settings → Library shows the detected GPU, the encoder Horde will use, and whether **this device** can play AV1. Amber warnings appear when a GPU-heavy mode is selected and ffmpeg in the Horde process has no GPU encoder (NVENC/QSV/VAAPI/AMF), or when a GPU is visible but ffmpeg cannot use it. That probe is the Horde container, not Ollama; Settings → System **GPU** / **None detected** is the same device visibility. Setup: [GPU](../ops/environment.md#gpu).

Changing the mode only affects **new** downloads. Library actions appear under the picker:

- **Create N copies**: backfills an H.264 copy for every video that would benefit (with an estimated size), using YouTube's H.264 when available and a local encode otherwise. Shows running/queued counts and a **Cancel**.
- **Convert library to H.264** (only in `h264_convert`): re-encodes every AV1/VP9 original in place after a confirm step. This is destructive; the only way back is to download again.

The summary line shows library size, how many copies exist and their size, and "checking codecs of N" while the one-time background probe of existing videos finishes. Full tradeoffs: [Playback compatibility](../guides/downloads.md#compatibility-codecs).

## Metadata and catalog

These are **top-level** keys (not the `ui` blob). The whole section is server-wide and shown to administrators only; `GET /api/settings` gives members the defaults of `metadata_sync_interval_hours`, `channel_catalog_enabled` and `channel_catalog_max_videos` (the two YouTube search switches keep their real values, because member screens use them).

### Channel catalog

| Setting | Key | Default | Range |
|---------|-----|---------|-------|
| Index channel libraries | `channel_catalog_enabled` | `true` | boolean |
| Max indexed videos per channel | `channel_catalog_max_videos` | `1000` | 100–5000 |
| YouTube results in channel search | `direct_youtube_search` | `true` | boolean |
| YouTube results in library search | `youtube_video_search` | `true` | boolean |
| Recommended+ looks on YouTube | `discovery_enabled` | `true` | boolean |
| Recommendations learn from the household | `discovery_household` | `true` | boolean |

When catalog indexing is enabled, Horde background-indexes **YouTube** channel uploads (titles; descriptions for the newest ~200) when you download from a channel or open its feed, so feed search works beyond the loaded page. Non-YouTube channel URLs are skipped.

**Max indexed videos per channel** caps how many of each channel's uploads are indexed, newest first, for channel feed search and auto-download. It does not limit how many videos you can download.

**YouTube results in channel search** (YouTube-linked channel pages only) also queries YouTube’s in-channel search and adds matches that are not already on screen. Combined results follow the channel page **Recent / Popular** sort. Search text is sent to YouTube. Each channel can override this default with the **YT** control in its search box.

**YouTube results in library search** is the **YT** control inside the main search bar: when it is highlighted, the home search box queries YouTube for videos that are not already in your library or catalogs after you pause typing (or immediately on Enter). The same setting is in Settings → Library. Search text is sent to YouTube. This is not the channel-page setting above.

**Recommended+ looks on YouTube**: every few hours, for each person who opened Recommended+ in the last three days, Horde makes up to four YouTube searches built from what they watch and reads the up next list of up to three videos they liked; at most 30 calls an hour for everyone, 20 seconds apart, behind anything you are doing, and it pauses for a while when YouTube pushes back. The search words are sent to YouTube. It also needs **YouTube results in library search**. Off: the Recommended+ tab is hidden (Recommended covers your library and indexed channels).

**Recommendations learn from the household**: library videos that people here with similar taste liked get a small lift in Recommended+. Nobody is shown who watched what.

!!! tip "Large indexes"
    Values above **1000** can take a long time and may slow other YouTube work while indexing. System → Background activity has **Refresh catalogs** / **Full reindex**.

### Metadata / catalog refresh interval

| Setting | Key | Default | Range |
|---------|-----|---------|-------|
| Refresh interval (hours) | `metadata_sync_interval_hours` | `24` | 1–168 |

How often Horde refreshes library video metadata and re-queues stale channel catalogs for a full index pass.

### Metadata resync action

From Library → Metadata and catalog:

1. Choose fields: **Everything**, **Views**, **Thumbnails**, **Captions**, **Titles & descriptions**.
2. Click **Resync metadata** to pull fresh data from each video’s source URL.

Progress also appears under [System → Background activity](system.md#background-activity).

### Media-server files

| Setting | Key | Default |
|---------|-----|---------|
| Media-server files | `media_server_sidecars` | `false` |

Writes `.nfo` files and thumbnails next to your videos so Jellyfin, Kodi or Plex show proper titles, descriptions and artwork when pointed at the same folder. Turning it on starts a background backfill of the whole library (progress under Background activity); turning it off leaves the files. **Remove sidecar files** (available once the setting is off) deletes them. Administrators only; a member's `GET /api/settings` shows `false`. What is written and how to set up each server: [Media servers](../guides/media-servers.md).

## Trash

Shown to anyone with the `delete_videos` permission (and administrators). The summary line gives the number of videos in the [trash](../guides/library.md#trash), their size and how many days the trash keeps them (`HORDE_TRASH_DAYS`; with `0` it says deletes are permanent). **Empty trash** erases everything after a confirm. **Show videos in the trash** opens the list: thumbnail, title, channel, size, who deleted it and when, and the days left, with **Restore** and **Delete forever** per video. A restore that would collide with the library (the same video downloaded again, or a download of it running) is refused with the reason.

The trash is here rather than under System → Storage because members who may delete videos need it, and the System tab is for administrators. Storage still shows the trash's share of the disk.

## See also

- [Settings overview](index.md)
- [History & continue watching](../guides/history.md)
- [Channels](../guides/channels.md)
- [System](system.md) — catalog refresh / reindex
- [All settings](all-settings.md)
