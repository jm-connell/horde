# Comments

Horde saves the top YouTube comments of the videos in your library, so they are there to read under the video, they count in search, and Ask, asked about a video, knows how viewers reacted. They stay when a video later goes private or is removed from YouTube.

## What is saved

For every library video that came from YouTube, Horde saves:

- the **top 100 comments**, in YouTube's "top" order (a pinned comment from the creator first);
- **replies to the most popular threads**: up to 10 replies each for the highest-ranked comments that have replies, 100 replies per video in all. Lower-ranked threads cost no extra request and keep their replies on YouTube.

Each comment keeps its author, whether the author is the creator, whether it is pinned or hearted by the creator, its like count and its approximate date (YouTube only says "3 years ago").

Comments are fetched in the background, one video every 30 seconds: a new download gets its comments within a minute or so, and the rest of the library is filled in newest first. Comments keep coming while a video is young, so they are fetched again when the video is **a week, a month, six months and a year old**, counted from when it came out on YouTube (from when it was added, if Horde does not know), and after that **every six months**. Ages already past when it is downloaded, or less than three days away, are skipped: a video downloaded the day it came out is fetched at all four ages, one downloaded two months after it came out at six months and a year, and one downloaded years later goes straight to the six-monthly refresh. Each fetch replaces the saved comments with the current top ones. When YouTube rate-limits Horde, the fetcher waits an hour (ten minutes when YouTube cannot be reached). A fetch that fails is tried again after an hour and after four hours; after that the video waits for its next refresh. Only the first request of each fetch waits its turn with downloads and previews; the comment pages are read after it, one a second, so they never hold up anything you are doing. Progress shows under **Settings → System → Background activity**.

Videos without a YouTube id (your own uploads, files from other sites, clips) have no comments.

## On the watch page

The **Comments** section sits under the description, with YouTube's total count beside the heading. The small **↻** button beside **On YouTube** fetches and saves the comments again now (hover it to see when they were saved); it needs the **Edit details** permission, and the background schedule carries on afterwards. A refresh that fails (YouTube busy or out of reach) changes nothing that was saved. It starts with five threads; **Show more comments** adds twenty at a time. A thread with saved replies has an **N replies** button that opens the discussion under it. Timestamps in a comment (`3:10`) seek the player, links open in a new tab, and a comment's date opens it on YouTube.

Past the 100 saved comments, **Show more comments** reads more from YouTube on the spot: the top 300, then the top 1000 (this can take a little while; the button says **Loading from YouTube…**). These are not saved (they are kept in memory for half an hour), and YouTube has to be reachable; if it is not, what is already shown stays and **Try again** reads again. Until a video's comments are saved, **Load them now from YouTube** fetches them straight away (and saves them, for anyone with **Edit details**).

A video you are only streaming (`/watch?url=…`) has nothing saved; **Load comments** reads its top 100 from YouTube.

When comments are turned off on YouTube, or YouTube no longer shows them (the video is private, removed, members-only, or age-restricted and Horde has no YouTube cookies), the section says so and shows the comments saved before, with the date they were saved. A later fetch that finds no comments never removes saved ones.

## In search and chat

- **Search**: a library video whose saved comments contain every word of your search shows up in **In your library**, after the videos that match by title, description, tags or notes. Its **?** badge quotes the comment ("In a YouTube comment: …"). Channel and tag filters apply as usual.
- **Video chat**: the [AI chat](ai-features.md#chat) about a library video gets the top comments (about 3,000 characters, with the creator's replies) next to the description and captions, labelled as viewers' comments. Ask it what people thought, whether anyone pointed out a mistake, or what the creator answered. It is told never to pass off a viewer's claim as what the video says.

## Turning it off

**Settings → Library → Comments** (administrators) is one switch for the whole feature. Off, nothing is fetched from YouTube, no one sees a comments section (on library videos or streams), and search and the video chat leave comments out. Comments already saved are kept, and turning it back on brings them back as they were; the fetcher then carries on with its schedule. Deleting a video deletes its comments.

Under the switch, Horde shows how much space the saved comments take (usually a few MB). While comments are off, **Delete saved comments** removes them all; turning comments on again afterwards fetches them from YouTube afresh.

## Size

A video's saved comments take about 30–60 KB of the database, search index included: roughly 150–300 MB for 5,000 videos. **Settings → Library → Comments** shows the exact figure. The nightly and pre-update backups copy the database, so count that several times. After **Delete saved comments** the backups shrink from the next one; the database file itself keeps the freed space for new data.

How it works: [ADR 0023](../adr/0023-saved-comments.md).
