# Stream hover warm-up

Approved in conversation on 2026-11-22.

## Why

Clicking a video that isn't downloaded should start playback as fast as
possible. TubeHaus does this by fetching a video as soon as the pointer rests
on its card, so most clicks land on something already fetched. Horde already
caches each step of opening a stream on the server, so starting those steps
on hover means the click finds them done.

## How a click works today

1. The watch page asks `GET /api/preview/meta`, which is one yt-dlp lookup
   (`stream_preview._extract_preview_info`). That takes about 2–5 s and runs
   through the global one-at-a-time YouTube gate with 1.25 s spacing. The
   result is cached for 3 min, and it's shared with download previews under the
   same key.
2. Shaka asks `GET /api/preview/manifest`. The server reuses the cached lookup
   and probes the CDN for each format's index (`_build_manifest_entry`), about
   another 1 s. The result is cached for about 5.5 h.
3. Shaka loads the media through `/api/preview/media`.

Only live channel feeds and the watch sidebar look anything up in advance:
feed cards run a background download preview when they scroll into view.
Search, history, discover, continue watching and channel video lists pass
`skipRemotePreview`, so nothing is warm when you click there.

## Goals

- A stream card that the pointer rests on is warmed up before the click. Its
  details are in the browser's query cache and its manifest is built on the
  server, so the watch page and the player find both ready.
- Opening a stream can't break because a warm-up built the same manifest.

## Non-goals

- Changing how Horde asks YouTube. Vision Pro first is a separate experiment,
  below.
- Cloudflare WARP address rotation, or reimplementing TubeHaus's SABR, TV and
  Kids chain. WARP only helps a server YouTube has already blocked, and it would
  put all YouTube traffic through Cloudflare. SABR, TV and Kids would mean
  maintaining a second YouTube engine next to yt-dlp.
- Buffering video bytes before the click.
- Warm-ups on touch devices. Touch-down fires at the start of every scroll that
  begins on a card, so phones would queue lookups for every flick.
- A setting to turn warm-ups off.

## Anti-goals

- A warm-up that slows the click. One running warm-up may delay a click on a
  different video by at most one lookup. Warm-ups must never pile up.
- Playback that starts twice, or resumes from the wrong place, because the
  watch page opened on warmed details.
- Warm-ups starving the existing background probes, or the other way round.

## Approaches

1. **Client-driven warm-up on the existing endpoints (chosen).** The browser
   prefetches `/api/preview/meta` into the same TanStack query the watch page
   reads, then requests the manifest so the server builds and caches it. It
   needs no new endpoint, and the click reuses the browser's cached details
   with no round trip.
2. A dedicated `POST /api/preview/warm` endpoint that does both server-side.
   That's one request per hover, but it's new API surface, and the watch page
   would still make its own details request.
3. Warm-up plus Vision Pro-first lookups. The gain is plausible but
   unmeasured, and it adds two cache entries, a fallback and a circuit breaker.
   It's deferred to an experiment.

## Design

### 1. One manifest build per video at a time (backend bug fix)

Today two non-forced `resolve_preview_manifest` calls for the same URL can build
at the same time. The second `_store_manifest_entry` evicts the first entry's
token. A player holding that token then gets 404 from `/api/preview/media`
(`lookup_preview_media` raises `KeyError`). This can happen today with two tabs
opening the same new video; a hover followed by a click would trigger it
routinely.

The fix: at most one build or refresh per URL at a time. Reuse the existing
`_preview_refresh_inflight` map rather than adding module state. A resolve
that finds the cache empty and a build in flight waits for it (bounded, like
`_PREVIEW_REFRESH_FOLLOW_WAIT_SEC`) and returns the cached entry. The
regression test has two concurrent resolves with a slow stubbed build, and
asserts one build, one token, and that the token resolves through
`lookup_preview_media`.

### 2. Hover warm-up (frontend)

- **Triggers:**
  - a mouse pointer resting 120 ms anywhere on a stream card;
  - a mouse button going down on it, about 100 ms before the click;
  - keyboard focus on its link, with the same 120 ms delay.

  `pointerType !== "mouse"` is ignored.
- **What a warm-up does:**
  1. `queryClient.prefetchQuery` with `queryKeys.preview.meta(url)` and
     `api.getPreviewMeta`.
  2. If the details came back, aren't live (`is_live`) and aren't already in
     the library (`library_video_id`), a `GET previewManifestUrl(url)` whose
     body is discarded. A live broadcast plays over the HLS proxy, and a library
     video redirects, so neither needs a manifest.
- **Limits:**
  - One warm-up in flight per tab.
  - One pending slot, and the newest hover replaces it.
  - A started warm-up is never aborted, because the server would keep working
    anyway.
  - A URL warmed in the last 3 minutes, matching the server's lookup cache, is
    skipped. A failed warm-up waits out the same window, so a video that can't
    play doesn't cost a lookup per hover; only a cancelled one may retry at
    once.
  - Warm-ups don't go through `ytPreviewQueue`, so they never wait behind the
    viewport quality-label probes.
  - No module-level state that tests must reset: keep it per `QueryClient`, or
    on a provider.
- **The watch page opens on warmed details as they are.** No second details
  request, no second `playStream`. Today a stale query refetches on mount, and
  the refetched object re-runs `setSource` → `playStream`, which resets the
  stream position. Opening a video also marks its details stale afterwards, so
  a later visit asks again and gets the current resume point.
- **Where:** every card that opens a stream: `ChannelFeedCard` (feeds, search,
  history, discover, continue watching, watch sidebar), the stream related grid
  and list, `LiveNowSection`, stream entries in playlists, and Takeout
  suggestions. Library cards are untouched; they already play on hover.

## Testing

- Backend: the manifest single-flight regression test (threads joined), plus
  the existing `stream_preview` / preview API tests stay green.
- Frontend:
  - vitest for the warm-up queue: dwell, dedupe window, one in flight, newest
    wins, live and library skips.
  - Playwright with routed `/api/preview/meta` and `/api/preview/manifest`
    (as `shaka-captions.spec.ts` does): hovering a stream card requests the
    details and the manifest once; the click makes no second details request;
    a quick sweep across several cards warms only the last; touch doesn't warm.

## Docs

- `docs/guides/player.md` or `watching.md`: hovering a video that isn't
  downloaded starts loading it.
- `docs/design/player-architecture.md`: the warm-up, and why it reuses the
  existing endpoints.
- `docs/ops/youtube-access.md`: hovers add lookups (one at a time per tab, at
  most one per video every 3 minutes).

## Left to the builder

- Where the warm-up hook attaches on each card (root vs link).
- The exact `staleTime`/invalidation mechanics for the watch page's details,
  and whether that needs a guard in `useWatchVideo` or only query options.

## Later: Vision Pro-first lookups (experiment, not in this round)

yt-dlp asks every client in its default list (`tv_samsung`, `visionos`, `web`)
for each video and merges the formats. For the TV and web clients it also
downloads and runs YouTube's player JavaScript. TubeHaus asks the visionos
client first and falls back only when refused.

For Horde the same idea is a yt-dlp setting: `player_client = ["visionos"]`
first, then the full list on refusal or when no playable MP4 formats come back.
yt-dlp marks visionos `REQUIRE_JS_PLAYER: False` and still downloads the watch
page, so the description, captions and storyboards would still be there.

It would need:
- its own cache key, so the download runner never sees a visionos-only format
  list;
- download previews to read that entry;
- no cookie retry or health record on the fast attempt;
- a circuit breaker after repeated refusals.

The gain is unmeasured (this sandbox can't reach YouTube), and TubeHaus's
0.2 s is a raw API call, not yt-dlp. Measure on the server first:

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

Compare round 2 (the player JavaScript is cached by then). It's worth building
only if visionos is clearly faster and `top`, `mp4video`/`m4a`, `auto` and
`storyboard` stay comparable.
