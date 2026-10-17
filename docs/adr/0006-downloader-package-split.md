# 0006. The downloader package split and the facade policy

Status: Accepted

## Context

`services/downloader.py` had grown to hold the download queue, the yt-dlp attempt loop, the ffmpeg postprocess queue, library commit, staging, progress, retry and duplicate rules and playlist import. It was the most-edited module, hard to test in pieces (tests patched module globals), and it mixed three lifecycles: a scheduler, a per-job pipeline and database mutations. Many callers (routers, the scanner, the catalog, tests) imported names from it, and several yt-dlp helpers were reached through it as a side effect.

## Decision

Move the pipeline into the `services/downloads/` package with one concern per module:

| Module | Concern |
|---|---|
| `queue` | `DownloadQueue`: FIFO dispatch, global pause, cancel, quality restart, reaper. It is **handed** the job runner, so it sits below it |
| `runner` | `run_download`: the yt-dlp attempt loop (format selectors, one cookie retry, recovery of a finished file), then hand-off to postprocess |
| `ffmpeg_queue`, `postprocess` | The bounded second stage and its steps; a `PostprocessTask` carries one job's hand-off |
| `finalize` | Promote from staging and commit the library row in one short transaction; queue AI, thumbnails, subtitles, sidecar |
| `jobs`, `spec` | Create, retry, re-qualify and de-duplicate job rows; a frozen `JobSpec` snapshot of what one run needs |
| `progress`, `lifecycle`, `errors`, `dbwrite` | Progress store and hooks; how a job leaves the pipeline (cancel, requeue, fail); exceptions; "database is locked" retries |
| `staging`, `artifacts`, `infodict`, `subtitles` | Where a job writes and how output is found and cleaned; info-dict helpers; subtitle fetch |
| `playlist_import`, `playlist_attach` | Playlist import as ordinary queue jobs; placing a finished download |

Importing the package binds the process-wide `download_queue` to the runner (`downloads/__init__`).

**Facade policy.** `services/downloader.py` stays for **one release** as a pure re-export module: no logic, no new names. A test (`test_downloader_facade.py`) asserts that every re-exported name is the same object as in its new home, so the facade cannot drift or silently break an out-of-tree import. New and edited code imports from the package modules directly; the API layer was moved over in the same change. At the next release the facade and its test are deleted.

## Consequences

- Each stage is readable and testable alone; `tests/test_download_pipeline.py` drives the whole pipeline with fake yt-dlp rather than patching module globals.
- The queue/runner split removes the import cycle and lets lifecycle functions read scheduler state through a small protocol instead of importing the queue.
- There is a deliberate window in which two import paths exist. Anything not covered by the facade list (private helpers) is not supported across the move.
- `download_queue`, `ffmpeg_queue` and `progress_store` are still process-wide objects. They are started and stopped through the `WorkerRegistry` ([ADR 0002](0002-single-process-worker-threads.md)); moving them onto `app.state` is a separate step.
- Log logger names change (`app.services.downloads.runner` instead of `app.services.downloader`), which matters for anyone filtering logs.

Detail: [Download pipeline](../architecture/downloads-pipeline.md).
