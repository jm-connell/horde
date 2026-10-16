# 0002. One process with in-process worker threads

Status: Accepted

## Context

Horde has a lot of background work: downloads, ffmpeg postprocessing, a filesystem scanner, metadata refresh, AI jobs, channel indexing, subtitle retries, backups. The usual answer is a task queue (Celery with Redis or RabbitMQ) and separate worker containers.

The deployment target is a NAS user running `docker compose up`. The job state that matters is already in SQLite (`download_jobs`, `ai_jobs`, `channel_catalogs`), the library is a shared filesystem, and most of the heavy lifting is done by child processes (ffmpeg) or I/O-bound calls (yt-dlp, Ollama, OpenRouter). Throughput is deliberately low: modest concurrency avoids getting an IP flagged by YouTube and avoids thrashing a home GPU ([single-flight AI](../design/single-flight-ai.md)).

## Decision

Run **one uvicorn process** and start every background loop as a **daemon thread** from the FastAPI `lifespan`, managed by one `WorkerRegistry` (`services/workers.py`, kept on `app.state.workers`).

- Each loop is a `BackgroundWorker` or implements the `ManagedWorker` protocol (`start`, `signal_stop`, `stop`, `is_alive`, `healthy`).
- The registry starts workers in dependency order and stops them in reverse, signalling all of them before joining any, with a per-worker timeout and an overall budget of 20 seconds. A worker that will not stop is logged by name.
- **Durable queues live in the database, not in memory.** A job is a row; the in-memory state is only progress and wake-ups. Startup runs recovery before any loop can claim work: `downloading` becomes `queued`, `running` AI jobs become `queued`, `indexing` catalogs become `queued`. A shutdown signal requeues in-flight work instead of cancelling it.
- Concurrency is bounded per resource, not per thread count: download slots, an ffmpeg slot pool, a single-flight AI runner, one catalog at a time, a global yt-dlp extract gate.
- Health is observable: `GET /api/ready` fails when a registered worker is unhealthy, and `/api/metrics` exposes `horde_worker_up` and queue depths.
- Workers are skipped under `HORDE_E2E` so browser tests are deterministic.

## Consequences

- Zero extra services to install, configure, secure or back up; one container, one log stream, one `docker stop`.
- Python's GIL is not a problem for this workload (child processes and network waits), but CPU-bound work must stay out of request threads.
- **Horde cannot run more than one process against a data directory.** The download queue, progress store, login throttle, extract gate and AI wake events are in-process objects, and SQLite allows one writer. Scaling out is not a goal.
- A crash loses only in-memory progress and queued in-memory H.264 copy jobs; everything durable is recovered at boot. Recovery code is part of the contract and is covered by tests.
- Older pieces are still module-level singletons (`download_queue`, the sprite pool, the AI wake event). New code holds state on objects created in `lifespan` or injected, so tests build a fresh one; tests join any thread they start.
- Shutdown takes up to about 30 seconds in the worst case (10 s connection drain plus the 20 s join budget), so the container needs a stop grace period above that (Compose sets 40 s).

Detail: [Background workers](../architecture/workers.md), [architecture map](../design/architecture.md#process-model).
