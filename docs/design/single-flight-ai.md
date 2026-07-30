# Single-flight AI

The AI subsystem runs a **single background worker** that executes **one job at a time**. Queue depth can be many; concurrency is not.

## Why

Homelab GPUs (and CPU-only Ollama boxes) do not enjoy unbounded parallel LLM and embedding calls:

- Two large models fighting for VRAM cause thrashing or OOM
- Concurrent embeds + chat inflate latency for both
- Recommendation “invent” passes already stream large prompts by design ([workload profiles](workload-profiles.md))

Single-flight keeps utilization predictable: jobs wait in `ai_jobs`, the worker claims the next eligible row, marks it `running`, dispatches, then completes or retries.

## What “single-flight” means here

| Behavior | Detail |
|----------|--------|
| One runner thread | `start_ai_worker()` loops `_process_one()` |
| Queue in SQLite | Kinds such as embed, enrich tags, refresh categories, etc. |
| Dedup while active | Enqueue skips if the same kind+target is already queued/running (unless `force`) |
| Pause switch | AI settings `paused` stops claiming new work |
| Wake events | New jobs / settings changes set an event so the worker does not only poll |

Downloads and yt-dlp extract paths have their **own** concurrency rules; “single-flight” in this document refers to the **AI job worker**, not the download queue.

## Operator experience

Settings → AI shows queue depth and breakdown (embeds vs tags vs categories). Large libraries backfill slowly by design — raise workload carefully, prefer local embeddings, and avoid starting Heavy invent on a critical GPU.

!!! note "Review items skip AI"
    Videos still in [review](review-queue.md) are generally excluded from embed/tag pipelines until cleared, so the queue is not wasted on unfinished imports.

## Related

- [Workload profiles](workload-profiles.md)
- [Local vs cloud AI](local-vs-cloud-ai.md)
- [AI pipeline](../architecture/ai-pipeline.md)
- [Background workers](../architecture/workers.md)
