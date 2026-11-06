# 0029. Questions about a video go to Ask

Status: Accepted

## Context

The watch page had its own chat: an **AI** section with **Summary** and **Chat** tabs, saved per user and video (`video_ai_chat_messages`, and `stream_ai_chat_messages` for streams, [0010](0010-stream-ai-retention.md)). Ask ([0028](0028-one-ask.md)) is the one chat everywhere else, answering from Horde or from channels. Two chats meant two histories and a second place to look, and the watch page chat could not answer a question about Horde or about the rest of the channel; Ask, open beside a video, did not know which video was on screen.

## Decision

- **A video is an Ask source.** `POST /api/ask/chat` takes a `video` the user picked or, when nothing is picked, the watch page's `page_video` (each a library id, or a stream's URL). A video turn runs the same chat runner the per-video chat used (`ai.chat.run_chat_turn`) with the same context (details, matching caption passages, saved comments; a stream's details and captions, its row saved first), uses the Assistant model like the rest of Ask, and is saved in the Ask thread.
- **The video is the default, not a cage.** With a video, a question naming Horde or about the user's own things goes to Horde, one naming a channel to that channel, and one about the video's whole channel to that channel when it is indexed. A question using Horde's feature words (theme, downloads, storage, docker, backup…) goes to Horde only when it is not about someone or something in the video ("what backup tool does he use?" stays), and once the video is picked only when it is also a how-to ("how do I…"): self-hosting videos use those words all the time. The client sends a picked video as `video` and the watch page's as `page_video` so the server can tell (`ask_chat.pick_route`, plain text rules in `knowledge/routing.py` and `help_data.topics`). A picked video stays picked through those answers and in the thread's saved scope; each reply's byline says where it came from.
- **Answers about a video are untrusted text.** Their context is a title, description, captions and comments anyone can write, so, like channel answers, they render help tokens as text and offer no setting changes, downloads or CSS.
- **Where the video comes from.** The watch page registers its video (`useAskPageVideo`); with nothing picked, questions there go to it ("Ask this video or Horde"). A video playing in the mini player on another page is only offered in the source menu ("Playing now"), so a general question does not land on it by accident. **Chat ↗** in the watch page's **Summary** section (what was the AI section) opens Ask on the video, or carries on the conversation already about it; a new conversation about a video is titled with it.
- **One history.** Revision `0029_video_chats_to_ask` copies every user's chat about each video into an Ask conversation scoped to that video (ownerless rows from before accounts go to the first administrator, or at bootstrap); the per-video chat endpoints and UI are gone. The old tables stay (only the trash still writes them) until a later revision drops them.
- **The switch still applies.** **AI video chat** (`ai_chat`) decides whether Ask answers about videos; off, the video is ignored and questions go to Horde.

## Consequences

- A video answer is saved in the conversation, not on the video, so downloading a stream mid-answer no longer loses it, and a conversation about a stream continues on the library copy (`resolve_video` maps a downloaded stream's URL to it).
- Video answers use the Assistant model rather than the plain chat model, which can cost more per answer when a stronger assistant model is set.
- The routing is keyword rules: with nothing picked, a question about the video that names no one in it and uses a Horde word ("how much storage does the NAS have?") goes to Horde. The byline shows it, and picking the video keeps such questions on it unless they name Horde, are a how-to, or are about the user's things or a channel.
- `video_ai_chat_messages` and `stream_ai_chat_messages` remain for the trash, account deletion, factory reset and the stream-to-library carry-over until they are dropped.
