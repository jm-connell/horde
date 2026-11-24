# 0038: Live 1440p and 2160p come from a separate extraction that runs Deno

Status: Accepted

## Context

Horde plays live broadcasts through its HLS proxy ([ADR 0009](0009-live-streams-hls-proxy.md)). YouTube's live HLS ladder stops at 1080p H.264, while youtube.com offers 1440p60 and 2160p60 for many broadcasts. Those come only as adaptive VP9 streams in WebM, and YouTube lists them only to clients that run its player JavaScript to solve a URL challenge. Horde ran yt-dlp without a JavaScript runtime, so yt-dlp fell back to its JS-less client, which sees the HLS ladder only. Among the JS clients, `tv_samsung` lists the VP9 formats without needing a PO token. Their segments are addressed as the format URL plus `&sq=n`, with the same numbering and 5 s timing as the HLS segments.

## Decision

- **Deno in the image, off PATH.** The Docker image copies Deno's official binary image (pinned by digest, updated by Dependabot) to `/opt/deno/deno` and sets `YTDLP_JS_RUNTIME=deno:/opt/deno/deno`. yt-dlp's challenge-solver scripts come from the pinned `yt-dlp-ejs` package, so Deno runs with no network or file access. Deno stays off PATH because yt-dlp uses a deno it finds there for every extraction.
- **For live only.** When a live session opens or refreshes its URLs, a second extraction (`tv_samsung`, the runtime, `formats=incomplete`, its own cache entry) looks up the adaptive formats. Every other extraction (downloads, previews, the live HLS ladder itself) is unchanged and JS-less.
- **Extra variants on the HLS timeline.** VP9 formats taller than the HLS ladder become extra variants of the master playlist. Their playlists repeat the tallest HLS variant's segments under `.webm` URIs, and they play beside the HLS audio rendition. The player keeps every codec for live.
- **Failure costs only the extra variants.** If the lookup fails, is not configured, or the broadcast muxes its audio, the stream plays as before, up to 1080p.

## Consequences

- The image grows by Deno, about 43 MB compressed (110 MB unpacked).
- Opening a broadcast for the first time takes about 2 seconds longer, while the second extraction runs.
- Auto quality can pick 1440p or 2160p where the browser reports it can decode that size; a viewer pulls 9 or 18 Mbit/s through the server, and a device that drops frames is stepped down by the existing health check.
- A yt-dlp release that needs newer solver scripts refuses the pinned `yt-dlp-ejs` until it is bumped too; live streams then stop at 1080p in the meantime.
- Running Deno for all of yt-dlp (yt-dlp's recommended setup) is a separate question; this record does not decide it.

Detail: [Live streams → 1440p and 2160p](../design/live-streams.md#1440p-and-2160p).
