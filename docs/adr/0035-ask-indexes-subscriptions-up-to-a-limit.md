# 0035: Ask indexes every subscription, up to a limit

Status: Accepted

## Context

Subscribing turned Ask on only for channels with up to 500 uploads; a bigger one waited for a confirm, and subscriptions made before that existed were never added. In production Settings → System reported 40 channels indexed (the channel catalog) while Ask reported one (its caption index). Two different things had one name, and most subscriptions were not in the one people meant.

## Decision

- Ask indexes a channel's newest uploads up to a limit: the app setting `ask_max_videos` (default 500, 50 to 5000) or the channel's own `kb_channels.max_videos`. A listing asks for at most the limit and deletes the videos beyond it, so lowering a limit removes the older ones and raising it fetches them.
- Subscribing turns Ask on whatever the channel's size. The confirm for large channels is gone (`confirm_large` and `large` left `POST /api/follows/ask-index`).
- Existing subscriptions are added once, by the Ask worker, without asking YouTube. It is not a standing rule: the switch on the Subscriptions page and **Turn off** keep meaning what they say.
- A data revision gives channels that already hold more than 500 uploads their count as their own limit, so the upgrade deletes nothing.
- The catalog and Ask's index stay separate stores ([0022](0022-ask-channel-knowledge.md)): the catalog holds upload metadata for feeds, the channel search box and automatic downloads, is trimmed and can be off; captions take hours to fetch. In the interface only Ask's is called "indexed"; the catalog is a "video list" that is "listed". Code, routes, tables and setting keys keep their names.

## Consequences

- The first start after the update queues every subscribed channel: at about 5,700 caption fetches a day, forty channels of 500 take three to four days, plus the embedding cost of each video. Channels take turns, newest videos first.
- The channel header's count is Ask's, against the channel's total uploads. The total comes from the catalog, so with the catalog off a channel larger than its limit shows "500 of 500+".
- A channel subscribed under a handle and already in Ask under its id is told apart by name when it is added, and otherwise dropped at its first listing.
- Library search coverage in Settings → System → AI still says "Indexed"; it counts the library's own videos and was left alone.
