# Decision records

Short records of the decisions that shape Horde and are expensive to reverse. Each one has the same three parts: **Context** (the forces at the time), **Decision** (what the code does now) and **Consequences** (what that costs and what it allows). They describe behaviour that exists in the code; when a decision is replaced, add a new record and mark the old one *Superseded* rather than rewriting history.

For the system as a whole see the [architecture map](../design/architecture.md).

| # | Decision | Status |
|---|----------|--------|
| [0001](0001-sqlite-wal-alembic.md) | SQLite with WAL, Alembic in batch mode, and a frozen legacy migrator | Accepted |
| [0002](0002-single-process-worker-threads.md) | One process with in-process worker threads, not Celery or Redis | Accepted |
| [0003](0003-auth-model.md) | Accounts: sessions, scrypt, admin and member permissions, signed media tokens, trusted-proxy mode | Accepted |
| [0004](0004-csrf-header-policy.md) | CSRF defence by request header and `Sec-Fetch-Site`, with no CSRF tokens | Accepted |
| [0005](0005-error-envelope-and-cursors.md) | One error envelope, cursor pagination, and no `/api/v1` prefix yet | Accepted |
| [0006](0006-downloader-package-split.md) | The downloader becomes the `services/downloads/` package (the temporary facade was removed in 1.1.0) | Accepted |
| [0007](0007-fts5-triggers-and-vector-index.md) | FTS5 and the tag table maintained by triggers; an incremental vector index cache | Accepted |
| [0008](0008-releases-and-rollback.md) | Releases, update channels, and rollback in `update.sh` | Accepted |
| [0009](0009-live-streams-hls-proxy.md) | Live streams through a server-side HLS proxy with a probed DVR window | Accepted |
| [0010](0010-stream-ai-retention.md) | AI results for streamed videos are kept per YouTube id, for a while | Accepted |
| [0011](0011-in-app-updates.md) | In-app updates: a request file in the data folder, run by a host cron job | Accepted |
| [0012](0012-password-reset-through-the-server-log.md) | Forgotten passwords: a one-time code in the server log | Accepted |
| [0013](0013-trash-tombstones.md) | Deleted videos wait in a trash: a tombstone row and moved files, not a soft-delete flag | Accepted |
| [0014](0014-playlist-ownership-and-visibility.md) | Playlists belong to a user and are App-wide or Private; a private one answers 404 to everyone else | Accepted |
| [0015](0015-watch-time-per-hour.md) | Watch time is counted from progress saves, stored per UTC hour, and outlives the video | Accepted |
| [0016](0016-two-step-sign-in.md) | Two-step sign-in: TOTP from the standard library, a signed ticket between the steps, recovery codes | Accepted |
| [0017](0017-openai-compatible-provider.md) | One OpenAI-compatible AI provider instead of Ollama plus OpenRouter | Accepted |
| [0018](0018-help-chat-retrieval.md) | Ask about Horde answers from shipped docs and source by keyword retrieval | Accepted |
| [0019](0019-recommended-plus.md) | Recommended+: a mixed feed of four kinds of picks, fed by a slow YouTube gatherer | Accepted |
| [0020](0020-youtube-history-from-takeout.md) | YouTube history comes from Takeout and is kept apart from Horde's own | Accepted |

## Writing a new record

Copy the shape of an existing one: a number one higher than the last, a short title, `Status`, then Context, Decision, Consequences. Link the code or the page that carries the detail instead of repeating it, and add the record to the table above and to the nav in `mkdocs.yml`.
