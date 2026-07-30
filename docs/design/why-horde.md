# Why Horde

Horde exists because long-form YouTube and other web video do not fit cleanly into traditional media-server taxonomies — and because “archive forever, still find it later” is a different job than “stream the latest episode.”

## The Plex “Other” problem

Plex (and similar libraries) shine at **Movies** and **TV**: posters, seasons, episodes, metadata agents. Everything else tends to land in a catch-all — often labeled **Other** — where:

- There is no natural season/episode structure
- Channel and upload date matter more than studio and year
- File names from yt-dlp are long and awkward as “movie titles”
- Search and browsing feel bolted on rather than first-class

If you keep years of talks, music videos, essays, livestream VODs, or channels you want offline, that catch-all becomes a graveyard: playable, but hard to browse, hard to share over SMB in a sane tree, and easy to lose track of.

Horde is built for that archive. The product metaphor is closer to a **personal YouTube library** than a movie shelf: channels, publish dates, tags, continue watching, and a download queue that speaks yt-dlp.

## TubeArchivist and peers

[TubeArchivist](https://github.com/tubearchivist/tubearchivist) and similar projects are solid YouTube archivers. Horde is not a clone of them. The goal was a single opinionated app that matches one homelab workflow:

| Concern | Horde’s bias |
|---------|----------------|
| Scope | YouTube-first, but any [yt-dlp](https://github.com/yt-dlp/yt-dlp)-supported URL |
| Disk layout | [Channel / year / title](channel-year-layout.md) so SMB browsing matches the UI |
| Watching | Custom player with mini player, theater, cast, SponsorBlock, chapters |
| Ops | [One container](single-container.md), TrueNAS / Dockge friendly, [no auth](no-auth.md) on a trusted LAN |
| Intelligence | Optional [local or cloud AI](local-vs-cloud-ai.md) for search, tags, summaries, recommendations |

If TubeArchivist already fits your habits, use it. Horde exists for people who wanted the UI, layout, and AI layer shaped a particular way — and who were willing to [vibecode](vibecoded.md) toward that shape.

## Archive-first, not feed-first

Horde assumes you are **keeping** video:

- Downloads land under a durable tree with stable relative paths (`file_path` is identity — see [channel/year layout](channel-year-layout.md))
- Dropped files go through a [review queue](review-queue.md) before they pretend to be organized
- Metadata, subtitles, thumbnails, and optional embeddings make the archive searchable years later
- Playback progress and history are first-class so “where was I?” survives browser sessions

It is not primarily a live YouTube client. Stream preview exists so you can check a video before committing disk space; the durable path is still download → library → watch from your server.

!!! tip "Name origin"
    **Horde** as in *hoard*: collect the videos you care about, keep them on your hardware, and still be able to find and watch them.

## Where this sits in the wiki

- Day-to-day use: [Library](../guides/library.md), [Downloads](../guides/downloads.md), [Watching](../guides/watching.md)
- Install: [Docker](../getting-started/install-docker.md), [TrueNAS / Dockge](../getting-started/truenas-dockge.md)
- Design siblings: [no auth](no-auth.md), [single container](single-container.md), [vibecoded](vibecoded.md)
