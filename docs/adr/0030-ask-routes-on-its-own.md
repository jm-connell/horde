# 0030. Ask routes each question itself; no source menu

Status: Accepted

## Context

[0028](0028-one-ask.md) put Ask's source beside its title as a menu (Automatic, Horde, a video, the channels), and [0029](0029-video-questions-in-ask.md) added videos to it. The menu asked people to choose a source before asking, which means knowing how Horde is put together (what Automatic does, that Horde and channels are separate pipelines). Most people would never open it, and they only learn that a question went to the wrong place once the answer is there. Meanwhile the routing is dependable whenever the question or the way Ask was opened gives a clear signal: a channel's name, Horde's name or the user's own things, **Chat** on a video, **Ask \<channel\>** on a channel's page.

## Decision

- **No source menu.** Ask routes every question (`ask_chat.pick_route`), and the question box hints where a question will go ("Ask this video or Horde…").
- **A chip only when Ask is focused.** After **Chat** on a video, **Ask \<channel\>** on a channel's page, or an answer from a channel, a chip beside the title names the video or channel, with **×** to go back to asking about anything. Nothing shows otherwise.
- **The fix sits where the mistake shows.** Each answer's byline says where it came from, and under the latest answer links ask the same question again from the other likely sources: **Ask Horde instead**, **Ask \<video\> instead** (the picked, watch page's or playing video), **Ask \<channel\> instead** (the page's channel). Asking a video or channel this way focuses the chat on it. The request's `answer_from` (`horde` / `video`) forces the source for that one turn; it replaces `horde_only`, and the "Horde only" pin is gone.

## Consequences

- One less concept to learn: Ask is just Ask, with its focus shown only when there is one.
- A wrong guess costs a click after the answer instead of a choice before it. The re-asked question is a new turn in the conversation; the first answer stays.
- Asking a channel without naming it needs its page (or **Ask \<channel\>** there), or naming it; the menu's channel list is gone.
