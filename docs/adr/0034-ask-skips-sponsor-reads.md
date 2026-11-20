# 0034. Ask leaves sponsor reads out of answers using SponsorBlock

Status: Accepted

## Context

Ask answers from caption passages. A host's sponsor read is captioned like the rest, so an answer about protein on a podcast cited the host's protein bar ad ("1 g of protein per pound") as advice. A prompt rule to skip ads catches explicit "sponsored by" reads but not casual ones, and deciding per passage with the model would slow every answer. SponsorBlock, which the player already uses in the browser, publishes crowd-sourced timestamps of ad reads.

## Decision

- The Ask worker asks SponsorBlock (`sponsor.ajay.app`) for each indexed video's `sponsor`, `selfpromo` and `interaction` segments and stores them on `kb_videos` (revision `0034_kb_sponsor_segments`). Intros and outros are not used: a podcast's intro previews what the episode covers.
- Only the server makes this request, with the public YouTube id and nothing else, in the background: right after a video's captions are stored (committed first, so no database lock is held) when the 3-second spacing allows, otherwise by a backfill that also covers videos indexed before this existed. A failure pauses requests for ten minutes and leaves the video due (the backfill tries the other videos before it again); it never fails indexing.
- Segments are applied when passages are picked for an answer, not at chunking: a passage at least half inside ads is left out; one partly inside keeps its other caption lines. A reference never opens at or quotes a caption line inside an ad. The **Said in videos** search skips mostly-ad hits and hits whose words match only inside an ad. Applying them at retrieval means already-indexed videos benefit without re-chunking or re-embedding, and a refreshed answer from SponsorBlock takes effect at once.
- Segments are often submitted days after upload, so each daily listing of a channel asks again about its videos younger than 30 days.
- On by default; `HORDE_ASK_SPONSORBLOCK=0` turns the requests off. It is not tied to each user's SponsorBlock setting, which only decides whether their player skips segments: the index is shared by everyone, and the request carries only public video ids, no Horde account or user data (SponsorBlock does see the server's address and which videos it indexes).
- The prompt rule to skip sponsor reads stays for videos SponsorBlock knows nothing about.

## Consequences

- Answer latency is unchanged: no request runs while a question is answered, and the filter reads columns already loaded with each video.
- Videos SponsorBlock has no segments for (small channels, new uploads before someone submits) still rely on the prompt rule.
- A video whose only matching passages are ad reads gives no excerpt.
- SponsorBlock learns which public videos a Horde server indexes.
