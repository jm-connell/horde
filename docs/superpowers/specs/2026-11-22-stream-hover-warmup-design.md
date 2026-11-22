# Stream hover warm-up and faster stream lookups

Proposed 2026-11-22, waiting for approval.

## Why

Clicking a video that isn't downloaded should start playback as fast as
possible. TubeHaus does this by fetching a video as soon as the pointer rests
on its card. It also gets each lookup down to about 0.2 s by asking YouTube as
the cheapest official app first and falling back to others only when refused.
Horde can borrow both ideas without replacing yt-dlp.

## How a click works today

1. The watch page asks `GET /api/preview/meta`, which is one yt-dlp lookup
   (`stream_preview._extract_preview_info`). That takes about 2–5 s and runs
   through the global one-at-a-time YouTube gate with 1.25 s spacing.
2. Shaka asks `GET /api/preview/manifest`. The server reuses the lookup if it
   is still cached (3 min) and then probes the CDN for each format's index
   (`_build_manifest_entry`), about another 1 s. The result is cached for about
   5.5 h.
3. Shaka loads the media through `/api/preview/media`.

yt-dlp asks as every app in its default list (`tv_samsung`, `visionos`, `web`)
and merges the formats. For the TV and web apps it also downloads and runs
YouTube's player JavaScript. That makes three or more YouTube requests per
video, and it accounts for most of the 2–5 s.

## Goals

- A stream card that the pointer rests on is warmed up before the click: its
  details and its manifest are ready, so the watch page and the player find
  everything already done.
- Stream lookups get faster and make fewer YouTube requests, whether or not a
  hover happened.
- Hover warm-ups stay cheap enough not to provoke YouTube's bot checks.

## Non-goals

- Replacing yt-dlp, or talking to YouTube's API directly. Everything below is
  yt-dlp configuration.
- TubeHaus's SABR, TV and Kids chain beyond what yt-dlp already does, and its
  Cloudflare WARP address rotation. WARP only helps a server whose address
  YouTube has already blocked, which is rare at home. It would put all YouTube
  traffic, downloads included, through Cloudflare, and it does nothing for
  speed. If a VPS user hits bot blocks, a plain proxy setting is a separate
  item.
- Buffering video bytes before the click (a server-side media cache). That's a
  follow-up if starts still feel slow.
- Warm-ups on touch devices. Touch-down fires at the start of every scroll that
  begins on a card, and Horde's lookups cost more than TubeHaus's.
- A setting to turn warm-ups off.

## Anti-goals

- Changing what a download downloads. The download runner and its metadata
  lookup keep the full app list.
- A warm-up that slows the click. One running warm-up may delay a click on a
  different video by at most one fast lookup. Warm-ups must never pile up.
- Playback that starts twice, or resumes from the wrong place, because the
  watch page opened on warmed details.

## Approaches

1. **Client-driven warm-up on existing endpoints, plus a fast-first lookup
   (chosen).** The browser prefetches `/api/preview/meta` into the same
   TanStack query the watch page reads, then requests the manifest so the
   server builds it. The server's stream lookup asks yt-dlp for `visionos` alone
   first. This needs no new endpoint, and the click reuses the browser's cached
   details with no round trip.
2. A dedicated `POST /api/preview/warm` endpoint that does both server-side.
   That's one request per hover, but it's new API surface, and the watch page
   would still need its own details request.
3. Hover warm-up only, without the fast-first lookup. That's simpler, but each
   warm-up stays a full 3+ request lookup, which is the expensive part both for
   speed and for bot checks.

## Design

### 1. Fast-first stream lookups (backend)

- `_extract_preview_info` first runs yt-dlp with
  `extractor_args.youtube.player_client = ["visionos"]`. Everything else stays
  as `youtube_extractor_args()` returns it, POT provider included. yt-dlp marks
  visionos as needing no player JavaScript (`REQUIRE_JS_PLAYER: False`). It
  still downloads the watch page, whose initial player response supplies the
  description, captions and storyboards. Only the streams come from visionos.
- **The fast result is accepted only if it can play.** A finished video needs at
  least one video-only MP4 format (avc1/av01) and one m4a audio format with
  URLs, which is what `_pick_adaptive_formats` needs. A live broadcast needs a
  format with a URL. Otherwise, or on any yt-dlp error, the lookup runs exactly
  as it does today, cookie retry and members-only handling included.
- The fast attempt doesn't retry with cookies and doesn't record a failure for
  `/api/health`. Refusals are expected for made-for-kids and some label videos.
  It logs at debug.
- Videos already remembered as needing cookies (`url_cookie_required`) skip the
  fast attempt.
- **Cache entries.** The fast result is cached under its own key, so the
  download runner, live checks and metadata sync never see a visionos-only
  format list. On a cache read:
  - Stream preview reads the full entry first, then the fast entry.
  - Download preview (`extract_preview`, used only for quality labels and size
    estimates) also reads the fast entry when the full one is missing. Without
    that, opening a stream would trigger a second, full lookup for the quality
    menu.
  - What download preview fetches on a miss does not change.
- Forced refreshes after a 403 use the same fast-first order.
- **Circuit breaker.** If the fast attempt fails for 3 different videos in a
  row, skip it for 30 minutes. That keeps a YouTube-side change from adding a
  wasted call and the 1.25 s gate spacing to every lookup until yt-dlp is
  updated. The state lives on the `AppContext` or an object it owns.

### 2. One manifest build per video at a time (backend bug fix)

Today two non-forced `resolve_preview_manifest` calls for the same URL can build
at the same time. The second `_store_manifest_entry` evicts the first entry's
token. A player holding that token then gets 404 from `/api/preview/media`
(`lookup_preview_media` raises `KeyError`). A hover followed by a click
triggers exactly this.

The fix: at most one build or refresh per URL at a time. Reuse the existing
`_preview_refresh_inflight` map rather than adding module state. A resolve
that finds the cache empty and a build in flight waits for it (bounded, like
`_PREVIEW_REFRESH_FOLLOW_WAIT_SEC`) and returns the cached entry. The
regression test has two concurrent resolves with a slow stubbed build, and
asserts one build, one token, and that the token resolves.

### 3. Hover warm-up (frontend)

- **Triggers:**
  - a mouse pointer resting 120 ms anywhere on a stream card (TubeHaus's
    timing);
  - a mouse button going down on it, about 100 ms before the click;
  - keyboard focus on its link, with the same 120 ms delay.

  `pointerType !== "mouse"` is ignored.
- **What a warm-up does:**
  1. `queryClient.prefetchQuery` with `queryKeys.preview.meta(url)` and
     `api.getPreviewMeta`.
  2. If the details came back, aren't live (`is_live`) and aren't already in
     the library (`library_video_id`), a `GET previewManifestUrl(url)` whose
     body is discarded.
- **Limits:**
  - One warm-up in flight per tab.
  - One pending slot, and the newest hover replaces it.
  - A started warm-up is never aborted, because the server would keep working
    anyway.
  - A URL warmed in the last 3 minutes, matching the server's lookup cache, is
    skipped. A failed warm-up may be retried.
  - Warm-ups don't go through `ytPreviewQueue`, so they never wait behind the
    viewport quality-label probes.
  - No module-level state that tests must reset: keep it per `QueryClient`, or
    on a provider.
- **The watch page opens on warmed details as they are.** No second details
  request, no second `playStream`. Today a stale query refetches on mount, and
  the refetched object re-runs `setSource` → `playStream`. Opening a video also
  marks its details stale afterwards, so a later visit asks again and gets the
  current resume point.
- **Where:** every card that opens a stream: `ChannelFeedCard` (feeds, search,
  history, discover, continue watching, watch sidebar), the stream related grid
  and list, `LiveNowSection`, stream entries in playlists, and Takeout
  suggestions. Library cards are untouched; they already play on hover.

## Check before building

This sandbox can't reach YouTube, so the gain is unmeasured. On the server:

```sh
docker compose exec horde python - <<'EOF'
import time, yt_dlp
from app.services.ytdlp_common import youtube_extractor_args
# Add a made-for-kids video id as the third entry to see the fallback case.
VIDEOS = ["dQw4w9WgXcQ", "jNQXAC9IVRw"]
def run(vid, fast):
    args = youtube_extractor_args()
    if fast:
        args = {**args, "youtube": {**args["youtube"], "player_client": ["visionos"]}}
    opts = {"quiet": True, "no_warnings": True, "skip_download": True, "extractor_args": args}
    t = time.monotonic()
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(f"https://www.youtube.com/watch?v={vid}", download=False)
    except Exception as exc:
        return f"{time.monotonic() - t:5.1f}s FAILED {str(exc)[:70]}"
    fmts = [f for f in info.get("formats") or [] if f.get("url")]
    mp4v = [f for f in fmts if f.get("ext") == "mp4" and f.get("acodec") == "none" and f.get("vcodec") not in (None, "none")]
    m4a = [f for f in fmts if f.get("ext") == "m4a"]
    top = max((f.get("height") or 0 for f in fmts), default=0)
    sb = any(f.get("format_note") == "storyboard" for f in info.get("formats") or [])
    return (f"{time.monotonic() - t:5.1f}s formats={len(fmts)} top={top}p mp4video={len(mp4v)} "
            f"m4a={len(m4a)} subs={len(info.get('subtitles') or {})} "
            f"auto={len(info.get('automatic_captions') or {})} storyboard={sb}")
print("yt-dlp", yt_dlp.version.__version__)
for rnd in (1, 2):
    for vid in VIDEOS:
        for fast in (False, True):
            print(rnd, vid, "visionos" if fast else "default ", run(vid, fast))
            time.sleep(2)
EOF
```

Compare round 2 (the player JavaScript is cached by then). What matters is the
time, and whether `top`, `mp4video`/`m4a`, `auto` and `storyboard` stay
comparable. If visionos is not clearly faster, or loses formats, drop part 1
and keep parts 2 and 3.

## Testing

- Backend (`TestClient` / unit, stubbed yt-dlp):
  - The fast attempt runs first.
  - It falls back on an error and on no playable formats.
  - The fast entry is invisible to the runner's key.
  - Download preview reads the fast entry.
  - The breaker trips and resets.
  - The manifest single-flight regression test. Threads are joined.
- Frontend:
  - vitest for the warm-up queue: dwell, dedupe window, one in flight, newest
    wins, live and library skips.
  - Playwright with routed `/api/preview/meta` and `/api/preview/manifest`
    (as `shaka-captions.spec.ts` does): hovering a stream card requests the
    details and the manifest once; the click makes no second details request;
    a quick sweep across several cards warms only the last.

## Docs

- `docs/guides/player.md` or `watching.md`: hovering a video that isn't
  downloaded starts loading it.
- `docs/design/player-architecture.md`: warm-up and fast-first lookup.
- `docs/ops/youtube-access.md`: visionos first, the full list on refusal, the
  breaker, and that hovers add lookups.
- An ADR (0036) for asking YouTube as visionos first, with the TubeHaus
  comparison and why WARP and SABR were left out.

## Left to the builder

- Where the warm-up hook attaches on each card (root vs link) and the exact
  `staleTime`/invalidation mechanics for the watch page's details.
- The breaker's home on the `AppContext`, and the cache key naming.
- Whether the meta query's warmed-entry handling needs a guard in
  `useWatchVideo` or only query options.
