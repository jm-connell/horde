# 0028. One Ask: a single name, with the source on show and pickable

Status: Accepted

## Context

The chat panel answers from two places: Horde's own docs, source, settings and the user's data ([0018](0018-help-chat-retrieval.md), [0021](0021-help-chat-acts-through-confirmed-tokens.md)), and indexed channels' captions ([0022](0022-ask-channel-knowledge.md)). The code was already one panel, one endpoint (`POST /api/ask/chat`) and one history, but the interface still named two features: the footer, title and placeholder said "Ask about Horde", the title changed to "Ask <channel>" when a turn went to a channel, the settings section and permission said "Ask channels", and the way back was an × titled "Ask about Horde instead". Routing by naming a channel was invisible until the answer came back, and a question about Horde that happened to name a channel ("how do I stop indexing …?") could not be kept on Horde.

## Decision

- **One name, Ask.** The footer button, the panel title, the phone tab (was "Chat") and the docs call it Ask. "Horde" and the channel names are its sources, not features. The settings section is **Channels Ask can answer from** and the permission **Manage channel indexing** (`manage_ask` is unchanged); the consent setting is **Ask: use my data**.
- **The source is always on show.** "Answering from …" above the question box names where the next answer comes from: the channels, **Horde** when Horde was picked, or with nothing picked "Horde or a named channel" ("<channel> or Horde" on a channel's page). Each reply's byline names where it came from. It is hidden only when there is nothing to choose: no indexed channels, or no AI (answers are documentation searches).
- **Picking a source overrides the guess.** The chip opens a menu, inside the panel just above the chip, of **Automatic**, **Horde** and the indexed channels. Picking a channel sends it as `channel_ids`, as a follow-up does. Picking Horde sends `horde_only`, and the server answers from Horde whatever the question names or the page is about. **Automatic** goes back to routing per question (naming a channel, or the channel page), so the existing way of asking keeps working. **New chat** starts on the source picked last.
- **The two pipelines stay separate.** Horde answers and channel answers keep their own retrieval, prompts and rendering (actions and CSS only in Horde answers, numbered references only in channel answers); only the routing in front of them gained one flag.

## Consequences

- Text that names the old features changed with this (UI, docs, catalog, e2e specs). Code identifiers (`help_chat`, `HelpChatPanel`, `AskChannel`) and the accepted records above keep their names.
- While Horde is picked, naming a channel does not switch to it; the user picks the channel or Automatic. That is the point of picking, and the chip says so.
- The pick lives in the tab's saved chat state (`horde.askChat`, with the conversation), not on the server: it survives closing the panel and reloading, and a new tab starts on Automatic.
- The menu opens inside the panel rather than as a floating menu: the panel is translucent (`backdrop-filter`), so a floating menu has to be portalled out and positioned by hand, and on a phone the panel moves when the keyboard closes.
