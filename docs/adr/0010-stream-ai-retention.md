# 0010. AI results for streamed videos are kept per YouTube id, for a while

Status: Accepted

## Context

The watch page plays videos that are not downloaded yet (`/watch?url=…`). Summaries, AI chapters and chat were tied to a library row (`video_ai_meta`, `video_ai_chat_messages`, both keyed by `videos.id`) and to caption files on disk, so a stream had none of them. Generating them costs LLM tokens, so regenerating on every visit is wasteful, but a stream that is never downloaded should not leave data behind forever.

## Decision

- A stream's results live in two tables keyed by **YouTube id**: `stream_ai_state` (title, description, the English WebVTT fetched once from the stream, summary, AI chapters) and `stream_ai_chat_messages` (each user's chat). They are written only when someone uses AI on the stream, never by just opening it. Streams without a YouTube id get no AI.
- Library videos and streams share one code path: `ai/tasks.generate_summary` and `generate_chapters` take a transient `Video` plus the caption text, and `ai/chat.run_chat_turn` takes a `ChatTarget` (a library video or a stream) that stores turns and builds the context.
- **Carry-over.** When the video is downloaded, finalize moves the results onto the new library video (`stream_ai.adopt_for_video`): the summary and chapters fill `video_ai_meta` unless the video already has its own, chat turns join each user's conversation about the video, in the order they were written. If the download lands while a reply is being written, a summary or chapters still go to the video; the chat reply is not stored and the page says so. The `stream-ai` worker repeats this hourly for videos that reached the library another way.
- **Retention.** Opening the stream restarts its clock. Rows nobody opened for `HORDE_STREAM_AI_RETENTION_DAYS` (default 30) are deleted by the same worker.
- Related videos for a stream mix library and indexed-catalog videos (`services/stream_related.py`), each marked with whether it is downloaded.

## Consequences

- Revisiting a stream reuses its summary and chat at no cost, and downloading keeps them.
- Captions are stored in the database for up to the retention period (tens to hundreds of KB per stream).
- Stream AI has no embeddings, so chat context is the metadata plus the whole caption text (trimmed), not retrieved chunks; tags are not generated for streams.
