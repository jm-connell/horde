# 0041: A related list keeps one place in four for the viewer's other interests

Status: Superseded by [0043](0043-related-lists-adapt-to-the-topic.md)

## Context

The related list on the watch page was ranked only by closeness to the playing video: its nearest neighbours by embedding among the downloaded videos and, for a stream, every listed channel's uploads. With a few videos on a topic that reads well. With hundreds (a Counter-Strike tournament channel's video list, a GTA RP series) all 24 places are the same topic, and the list stops being a place to find the next thing to watch: someone who is done with the topic has to go back to the home page.

Spreading the nearest neighbours apart (MMR and the like) does not help, because the hundred nearest are all the same topic. The other places have to come from somewhere else, and the videos most likely to be wanted there are the ones [Recommended](0019-recommended-plus.md) already ranks for this person.

## Decision

- **Three on the topic, then one from another interest** (`services/discovery/other_interests.py`, `weave`). The list starts with three on-topic videos, so the first card is always related. "Autoplay related" plays the first video in the list not watched in this sitting, which is on the topic until the three before an other-interest pick have all just been played. On a stream the channel's live broadcasts and the next part of a series still lead and count as on-topic places.
- **The other places come from the viewer's Recommended feed**, in its order: not blocked, already mixed across their interests, and unwatched apart from the feed's few rewatch picks. A related list reads the day's ranking as it is kept (`ranked_feed(..., fresh=False)`, the home page's default seed, the one ranked in the background for people who use Recommended) and does not rank the feed again for every video opened. Nothing is recorded as shown.
- **"Another interest" is measured, not assumed.** A pick is never from the playing video's channel. With embeddings it must also be clearly less close to the video than the video's nearest neighbours: below the midpoint between what this embed model gives unrelated videos (the bottom tenth of every vector known) and the mean of the ten nearest. A fixed cosine would not hold across embed models ([0019](0019-recommended-plus.md) has the same problem). A pick without a vector might be on the same topic and is left out. Without embeddings the related list is the channel's videos, and any other channel's pick counts.
- **A library video's list takes downloaded picks only**, because that list holds library videos (`GET /api/videos/{id}/related` returns `VideoRead`). A stream's list takes any pick.
- **Parental controls apply before the mixing.** A restricted member's picks are limited to their allowed channels first (`Viewer.allowed`), so a place is never given to a pick the endpoint would then remove; the endpoints' own filters stay as the guard.
- **The picks do not depend on the page.** A list is handed the same picks (48 at most) whatever page is asked for, so every page of a library video's list is a slice of one sequence.
- **No setting.** One place in four is a constant (`ON_TOPIC_RUN`).

## Consequences

- Under a video on a topic the viewer has a lot of, 18 of 24 related videos are on the topic and 6 are from their other interests. A long run of autoplay can now leave the topic by itself. Someone with no watch history, or whose feed is all one topic, gets the list as before. When nearly everything Horde knows (more than nine videos in ten, across the library, the video lists and the found videos) is the playing video's topic, "unrelated" cannot be told apart and a pick from another channel on the same topic can pass as another interest.
- A related list opened when no ranking of the day is kept (it lapsed after 15 minutes and the background ranking has not replaced it, or the person never opens Recommended) pays for one feed ranking, a few tenths of a second on a library of thousands; the others cost one matrix product. Like a further page of the feed, the read holds the background ranking off that feed for two minutes.
- The other-interest picks follow the feed's cache, so a video watched a few minutes ago can still appear until the feed is ranked again. If the feed is ranked again between two pages of a library video's list, a video can repeat, and the watch page drops repeats.
