# 0037: Live chat is polled once per broadcast and follows the viewer's position

Status: Accepted

## Context

Chat replay ([ADR 0036](0036-chat-replay-read-around-the-position.md)) covers finished streams. A broadcast that is live now has no replay: YouTube serves its chat only from about the last 75 messages onward, then by polling `live_chat/get_live_chat`. Horde's live player has a DVR window of up to four hours ([ADR 0009](0009-live-streams-hls-proxy.md)), so a viewer may be watching well behind live. The user wanted chat to follow the moment being watched, not stay at the live edge.

## Decision

- **One poller per broadcast.** The first read opens the chat and starts a thread that polls YouTube at the pace it asks; everyone watching the broadcast reads the same in-memory buffer. Nothing is saved.
- **Follow the viewer.** Messages keep their send time. A read asks for what was sent up to `now - behind_ms - edge lag` (the player's own hold-back behind the newest segment), after a sequence number; the browser reads every 2 s and afresh after a scrub back. Chat older than the buffer shows a note.
- **Bounded and quiet.** The buffer holds at most the DVR window and 20 000 messages. Polling stops when nobody reads for a minute, when the broadcast ends or on a rate limit; the buffer stays served until nobody has read it for 10 minutes.
- **One panel.** Live chat uses chat replay's panel, placements and setting (`showChatReplay`, shown as **Show live chat**). Deleted messages disappear.

## Consequences

- YouTube sees one chat request every few seconds per broadcast being watched, however many viewers.
- A viewer who scrubs back further than Horde has been collecting sees a note, not chat: YouTube gives no older live chat.
- Chat runs a few seconds ahead of the picture (YouTube's encoder delay is not measured), as it does on YouTube.
- When YouTube changes the live chat endpoints, live chat breaks until the loop is patched, as for chat replay.

Detail: [Live streams → Live chat](../design/live-streams.md#live-chat).
