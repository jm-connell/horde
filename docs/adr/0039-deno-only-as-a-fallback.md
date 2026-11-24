# 0039: Deno runs only as a fallback, not for all of yt-dlp

Status: Accepted

## Context

With Deno in the image for live 1440p/2160p ([ADR 0038](0038-live-1440p-and-2160p-need-deno.md)), Horde could run every yt-dlp extraction with it, which is yt-dlp's recommended setup. An A/B test on 37 varied videos ([evaluation](../superpowers/specs/2026-11-24-deno-for-all-ytdlp-evaluation.md)) compared today's JS-less setup with Deno for everything:

- The formats, Horde's picks and download speeds were the same, except on two videos where Deno chose YouTube's "stable volume" audio track.
- Every Deno extraction took about 1.3 s longer, through the single extract gate.
- The `tv_samsung` client's URLs answer 403 until YouTube's pre-roll ads would be over (about 4 s here), which Horde's stream preview read as expired URLs.
- The challenge solver crashed on some YouTube player versions.
- Made-for-kids videos fail without Deno ("This video is not available") and work with it.

## Decision

- **JS-less by default.** Every extraction runs as before.
- **One retry with Deno for that one answer.** When an extraction gets exactly "This video is not available" and `YTDLP_JS_RUNTIME` is set, it is retried once with yt-dlp's `tv_samsung` client in Deno. This covers the extract gate (metadata, previews, download metadata) and the download itself, where yt-dlp only logs the error. Deleted and private videos answer differently and are not retried.
- **Previews wait out new URLs.** Stream preview waits until a format's `available_at` (the end of YouTube's pre-roll ads, at most a minute) before reading a URL, so the delay is not mistaken for expiry. The DASH build waits after the preview semaphore is released; the progressive proxy waits in the request, holding no lock.
- **The answer stays YouTube's.** When the Deno retry fails too, the original "not available" error is the one raised and recorded, so the channel catalog still skips the video.

## Consequences

- Made-for-kids videos download and preview; they start a few seconds later than other videos (as long as YouTube's pre-roll ads would run). Their subtitles are not fetched yet.
- Nothing changes for any other video.
- A video that is unavailable for another reason but gets the same message from YouTube costs one extra extraction before it fails.
- Whether to run Deno for everything can be revisited when yt-dlp's JS clients stop carrying the URL delay or start offering formats the JS-less client lacks; re-run the evaluation then.
