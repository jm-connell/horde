# Ask indexes every subscription, up to a limit

Approved in conversation on 2026-11-21.

## Why

In production Settings → System said 40 channels were indexed while Ask said one
was, and not ready. Horde has two things called "indexed": the channel catalog
(each channel's list of uploads) and Ask's index (what the videos say). Only one
channel was in Ask's, because subscribing turned Ask on only for channels with
up to 500 uploads, and only for subscriptions made after that existed.

## Goals

- Every subscribed YouTube channel is indexed for Ask, newest videos first, up
  to a limit. No "too large, confirm first" step.
- One app-wide limit (default 500) and an optional limit per channel.
- The channel page shows how much of the channel Ask has, against the channel's
  total uploads, and that count opens the limit.
- Only Ask's index is called "indexed". The channel catalog is a video list.

## Non-goals

- Merging the two stores. The catalog holds upload metadata for a channel's
  feed, its search box and automatic downloads; it is trimmed and can be switched
  off. Ask holds captions, which take hours to fetch. They stay separate tables
  and workers (ADR 0022); the catalog is renamed in the interface instead.
- Unsubscribing does not remove a channel from Ask.
- Renaming code, tables, routes or setting keys.

## Approaches

1. **Keep the subscribe-time hook, drop the size gate, backfill once** (chosen).
   Subscribing already turns Ask on (by hand through `POST /api/follows/ask-index`,
   and after a download subscribes someone), with a switch to leave it off. The
   gate goes, the limit caps the work, and a one-time pass adds the existing
   subscriptions. Turning Ask off for a channel stays off.
2. A worker pass that keeps Ask in step with all subscriptions. One rule, but
   the subscribe switch and "Turn off" would stop meaning anything: the pass
   would turn the channel back on.
3. Raise the 500 gate. Does not fix existing subscriptions or large channels.

## Design

- **Limit.** App setting `ask_max_videos` (default 500, 50 to 5000).
  `kb_channels.max_videos` (already there, never set) is the channel's own
  limit; null means the app-wide one. The limit counts uploads, and separately
  past live streams when those are included.
- **Listing** asks YouTube for at most the limit. After a listing, videos beyond
  the limit that are no longer listed are deleted with their passages, so
  lowering a limit removes the older videos and raising it fetches them.
  Changing a channel's limit, or the app-wide one for channels that follow it,
  lists the channel again.
- **Upgrade.** A revision gives every Ask channel that already holds more than
  500 uploads its current count as its own limit, so upgrading deletes nothing.
- **Subscribing** turns Ask on whatever the channel's size. `confirm_large` and
  `large` leave the API.
- **Backfill.** Once per installation (flag `ask_subscriptions_indexed` in the
  app settings), the Ask worker adds every subscribed channel Ask does not
  have, queued, without asking YouTube. A channel that turns out at its first
  listing to be one Ask already has under another address is dropped.
- **API.** `AskChannelRead` gains `max_videos` (own limit or null), `limit`
  (the one in force) and `channel_total` (the channel's uploads when known:
  from the catalog, or the listed count when the listing ended before the
  limit). `PATCH /api/ask/channels/{id}` takes `max_videos`.
- **Interface.** The channel header's count is Ask's ("312 of 2,310 indexed")
  and opens the Ask section of channel settings, which has the limit: this
  channel only, or every channel (administrators). Settings → Library → Ask has
  the app-wide limit. Catalog wording changes from "index" to "video list".

## Costs to know

Caption fetches are spaced 15 seconds apart (about 5,700 a day) and each video
is embedded with the configured provider. Forty channels at 500 is up to 20,000
videos: three to four days. Channels take turns, newest first.
