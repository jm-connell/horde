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

### Progress expiry

| Setting | Key | Default | Range | Storage |
|---------|-----|---------|-------|---------|
| Progress expiry (days) | `progress_expiry_days` | `14` | 1–365 | Top-level `app_settings.json` (mirrored locally as `progressExpiryDays`) |

Saved watch position resets after this many days of **inactivity**.

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

Formerly the separate Downloads settings tab (legacy `?tab=downloads` → Library).

| Setting | Key | Default | Notes |
|---------|-----|---------|--------|
| Show active download count in navigation | `showDownloadNavBadge` | `true` | Badge on Download while jobs are queued/running |
| Normalize volume on download | `normalizeVolumeOnDownload` | `true` | Loudness normalization via ffmpeg on new downloads |
| Archive video codec (beta) | `downloadVideoCodec` | `"av1"` | `av1` \| `h264` \| `h265`. Stamped onto every new download. Default is AV1. |

**AV1** (default) is YouTube’s high-res codec: smallest files, best quality, no video encode, weaker device support. **H.264** is the largest files and the widest playback; 1440p/4K must be converted from AV1 because YouTube has no H.264 there. **H.265** is smaller 1440p/4K than H.264 after that same conversion. The server GPU (passed into the Horde process, not Ollama) speeds 1440p/4K encodes; without it, software transcode is very slow. Full tradeoffs: [Compatibility codecs (beta)](../guides/downloads.md#compatibility-codecs).

Settings → Library shows a **Recommended** hint from ffmpeg in the Horde process (NVENC/QSV/VAAPI), not from Ollama VRAM. Settings → System **GPU** / **None detected** is the same probe’s device visibility. If the GPU is visible but Horde cannot encode, pass the device into the **horde** container (see [GPU](../ops/environment.md#gpu) and [Compatibility codecs (beta)](../guides/downloads.md#compatibility-codecs)). Existing library files are unchanged until you redownload / change resolution.

## Metadata and catalog

These are **top-level** keys (not the `ui` blob).

### Channel catalog

| Setting | Key | Default | Range |
|---------|-----|---------|-------|
| Index channel libraries | `channel_catalog_enabled` | `true` | boolean |
| Max videos per channel | `channel_catalog_max_videos` | `1000` | 100–5000 |
| Direct YouTube search | `direct_youtube_search` | `true` | boolean |
| YouTube video search | `youtube_video_search` | `true` | boolean |

When catalog indexing is enabled, Horde background-indexes **YouTube** channel uploads (titles; descriptions for the newest ~200) when you download from a channel or open its feed, so feed search works beyond the loaded page. Non-YouTube channel URLs are skipped.

**Direct YouTube search** (YouTube-linked channel pages only) also queries YouTube’s in-channel search and adds matches that are not already on screen. Combined results follow the channel page **Recent / Popular** sort. Search text is sent to YouTube. Each channel can override this default (on / off / use Library default).

**YouTube video search** is the Library home toggle: with it on, the home search box queries YouTube for videos that are not already in your library or catalogs after you pause typing (or immediately on Enter). The same setting is in Settings → Library. Search text is sent to YouTube. This is not the channel-page Direct YouTube search.

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

## See also

- [Settings overview](index.md)
- [History & continue watching](../guides/history.md)
- [Channels](../guides/channels.md)
- [System](system.md) — catalog refresh / reindex
- [All settings](all-settings.md)
