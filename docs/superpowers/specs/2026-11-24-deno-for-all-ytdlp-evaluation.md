# Should all of yt-dlp run with Deno? A/B evaluation

Date: 2026-11-24. yt-dlp 2026.10.26 (Horde's pin), yt-dlp-ejs 0.8.0, Deno 2.9.8.

Outcome: the fallback below was built ([ADR 0039](../../adr/0039-deno-only-as-a-fallback.md)).

**Recommendation: don't switch.** Deno gave the same formats and the same downloads for nearly every video, and cost more on every one of them: about 1.3 s per extraction, a 4 s wait before new URLs work (which breaks Horde's stream preview as it is written), and challenge-solver crashes on some YouTube player versions. Its one real win is **made-for-kids videos**, which today's setup cannot open at all. That one is worth getting through a narrow fallback (below), not a global switch.

## What was compared

- **A (today):** Horde's yt-dlp options (`youtube_extractor_args()`), no JavaScript runtime, so yt-dlp uses its JS-less `visionos` client.
- **B (Deno for everything):** the same options plus `js_runtimes={"deno": ...}`, so yt-dlp's default clients become `tv_samsung`, `visionos` and `web` and it solves YouTube's player challenges in Deno.

Both used Horde's real download pick, `format_chain("best", "av1")` with `FORMAT_SORT`. The sample was 37 public videos in 12 kinds: 4K/HDR/Dolby Vision, 8K, real Shorts, long compilations, music videos, 3-5 h podcasts, lectures, trailers, videos with 16-22 dubbed audio tracks, made-for-kids, gaming, news and past live streams. A and B alternated which went first per video, spaced like Horde's extract gate.

## Results

### Extraction (37 videos each)

| | A (today) | B (Deno) |
|---|---|---|
| Extracted | 35 / 37 | **37 / 37** |
| Failures | both made-for-kids videos: "This video is not available" | none |
| Time, median (mean, max) | **1.41 s** (1.44, 2.05) | 2.67 s (2.74, 4.68) |
| Highest quality offered | same on all 35 | same on all 35 |
| AV1 / VP9 / HDR / audio languages offered | same on all 35 | same on all 35 |
| Horde's pick (format ids) | — | identical on 33 of 35; on 2 Shorts B picked YouTube's "stable volume" audio (`140-drc`) instead of the normal track |
| Challenge-solver crashes | n/a | 4 of 37 (`a.addOnDisposeCallback is not a function` on players `b485e332`, `fbe70791`); yt-dlp then fell back to `visionos` formats, so those ended up as A's result, just slower |

### Using the URLs

| | A | B |
|---|---|---|
| 2 MB read of the picked streams right after extraction | 35 / 35 fine | **25 / 37 answered 403**, 12 fine |
| Why | | `tv_samsung` URLs carry a pre-playback wait: they answer 403 for about 4 s after extraction (yt-dlp exposes it as `available_at`). Checked with the same URL: 403 at 0.1, 1.2 and 2.3 s, 206 at 3.6 s. `visionos` URLs work at once. |
| Full yt-dlp downloads (3 videos, Horde's pick, merged) | 3 / 3 | 3 / 3, same files; 0.2 to 5 s slower (yt-dlp waits out `available_at`) |
| Player-style read, 1 MiB every 2 s for 90 s | 5 / 5 videos, 45 / 45 reads | 0 / 4 without waiting; **4 / 4, 45 / 45 reads** once the wait is honoured |
| Live 1440p/2160p lookup (`tv_samsung`) | n/a | live URLs have no wait; unaffected |

Solver failure rate, 6 extractions each with only `tv_samsung`: 1 / 6 on yt-dlp 2026.10.26, 0 / 6 on 2026.11.23. YouTube served only the working player to the second run, so this does not show the newer version fixes it; both pin yt-dlp-ejs 0.8.0.

## What switching would break or cost

1. **Stream previews.** The preview proxy (`api/preview.py`) fetches format URLs straight away and treats any 401/403 as expired URLs to re-extract. Under B the first fetch of almost every preview would hit the 4 s wait, re-extract, get new URLs with a new wait, and stall or fail. The proxy would first need to wait until `available_at` instead.
2. **Slower everything.** About +1.3 s per extraction, through the single global extract gate, so feed cards, previews, download starts and the channel catalog all queue longer. Downloads also start up to 4 s later.
3. **Solver fragility.** When YouTube rolls out a player the pinned solver cannot handle, B quietly degrades to A's formats, but only after paying for the failed attempt. Keeping yt-dlp and yt-dlp-ejs in step becomes a release concern for every extraction, not only live 4K.
4. **Gains elsewhere: none seen.** Same formats, same codecs, same picks and the same download speed (110-130 Mbit/s for both on 4K).

## Recommended instead: Deno only as a fallback for unavailable videos

Made-for-kids videos fail in A with "This video is not available" and work in B (1080p AV1 here). The cheapest way to get them is a fallback like the existing cookie retry in `extract_info_gated`:

- When a JS-less single-video extraction fails with that error and `YTDLP_JS_RUNTIME` is set, retry once with the JS clients (`tv_samsung`).
- The common path stays exactly as it is today: no extra time, no waits, no solver.
- Downloads through yt-dlp already wait out `available_at`. For previews of such videos the proxy should honour `available_at` (sleep until it, instead of re-extracting on that first 403).

## Limits of this test

- One machine and one IP, over one evening. YouTube varies its player versions and its behaviour by IP.
- No bgutil PO-token sidecar locally. Horde's Docker setup has one, so in production B's `web` client would also contribute formats. Those need PO tokens and could change some picks; not measured.
- No cookies, so age-restricted and members-only videos were not tested in either setup.
- Flat listings (channels, playlists, search) do not run the player, so they were not compared.

Raw data: `results.jsonl` (37 × 2 extractions and stream probes), `stream_results.jsonl` (downloads, sustained reads) and `stream_wait_results.jsonl` (B sustained reads honouring the wait), in the session's scratchpad.
