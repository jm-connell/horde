# AI setup

Optional AI powers embeddings (hybrid search), tags, summaries, chat, recommendations, and category shelves. Providers: **Ollama** (local) and/or **OpenRouter** (cloud).

!!! tip "UI controls"
    Most knobs live under [Settings → AI](../settings/ai.md). This page covers Compose, discovery, VRAM tiers, workloads, and budgets.

## Enable Ollama via Compose

```bash
docker compose --profile ai up -d
```

That starts the `ollama` service (profile `ai`) with models under `OLLAMA_DATA_PATH` (default `./ollama`). Horde does not require the profile if Ollama already runs elsewhere — set `OLLAMA_BASE_URL` or leave it empty for auto-discover.

### GPU templates

Compose comments include passthrough snippets for NVIDIA (`deploy.resources`), AMD ROCm (`/dev/kfd`, `/dev/dri`), and Intel (`/dev/dri`). Uncomment the block that matches your host. For a GPU on another machine, leave the local `ollama` service off and point Horde at that host.

Horde’s **download transcode** GPU (beta) is a separate pass-through on the `horde` service. Settings → System → **GPU** / **None detected** is that container, not Ollama. See [GPU](environment.md#gpu).

## `OLLAMA_BASE_URL`

| Value | Behavior |
|-------|----------|
| Set (e.g. `http://192.168.1.50:11434`) | Always use this URL |
| Empty | Auto-discover (below), after any URL saved in Settings |

`OPENROUTER_API_KEY` in the environment overrides the key stored in Settings when set.

## Auto-discover order

Settings URL (if any) is tried first, then:

| Runtime | Order |
|---------|-------|
| **Inside Docker** (`/.dockerenv`) | `http://ollama:11434` → `http://host.docker.internal:11434` → `http://127.0.0.1:11434` |
| **Host / local dev** | `http://127.0.0.1:11434` → `http://host.docker.internal:11434` → `http://ollama:11434` |

Compose gives Horde `extra_hosts: host.docker.internal:host-gateway` so a host-installed Ollama is reachable from the container.

## VRAM tiers

Horde sizes models against the **Ollama machine’s** GPU (override → Ollama `/api/info` → same-host probe), not necessarily the Horde host.

| Tier | VRAM | Default embed | Default chat |
|------|------|---------------|--------------|
| **critical** | &lt; 3 GB | `all-minilm` | `llama3.2:1b` |
| **small** | 3–8 GB | `nomic-embed-text` | `qwen2.5:3b` |
| **medium** | 8–16 GB | `mxbai-embed-large` | `qwen2.5:7b` |
| **large** | ≥ 16 GB | `mxbai-embed-large` | `qwen2.5:14b` |
| **unknown** | undetected | `nomic-embed-text` | `qwen2.5:3b` |

If VRAM cannot be read for a remote Ollama, set **Settings → AI → Ollama VRAM (GB)** so tiers stay accurate.

## Workload profiles

Profile scales invent/sample intensity and enqueue batch limits (models stay tier-based):

| Profile | Intensity multiplier | Notes |
|---------|----------------------|-------|
| **Light** | **0.4×** | Smaller samples, higher category match threshold |
| **Normal** | 1.0× | Default for small/medium |
| **Heavy** | **1.75×** | Larger samples; enqueue limits ×2 |

**Critical** VRAM **locks** the profile to **Light** so models fit. Recommended defaults: critical→light, large→heavy, medium/small→normal.

## OpenRouter scope

| Scope | Behavior |
|-------|----------|
| **specialized** (default) | Summaries, chat, tags, duplicate confirmation via OpenRouter; embeddings stay on Ollama when available |
| **all** | All AI tasks including embeddings go through OpenRouter (unless you prefer Ollama embeddings) |

### Prefer Ollama embeddings

`ollama_prefer_embeddings` (Settings) keeps embeddings on Ollama even when OpenRouter scope is **all**. Useful for privacy or cost.

!!! warning "Reindex after embed model change"
    Vectors are model-specific. Changing the embed model (or switching OpenRouter ↔ Ollama for embeddings) requires rebuilding indexes — use AI maintenance **reindex** / rebuild search indexes. Stale vectors break hybrid search and recommendations.

## Weekly budget

OpenRouter spend is tracked locally in `openrouter_usage` (rolling 7 days).

- Set a **weekly budget** (USD) in Settings → AI.
- Enable **hard limit** to block further OpenRouter calls and **pause the AI queue** when spend ≥ budget.

Soft budget alone warns in the UI without stopping the queue.

## Queue visibility & recovery

Settings → AI → Jobs shows **runnable / deferred / waiting / failed** counts plus a blocked reason when providers are down. Terminal failures list under **Failed jobs** with Retry / Retry all / Clear failed.

If Ollama was offline, waiting jobs resume automatically once it is reachable again (no Horde restart required). See [Troubleshooting — Ollama offline](troubleshooting.md#ollama-offline).

## Related

- [AI features guide](../guides/ai-features.md)
- [AI pipeline](../architecture/ai-pipeline.md)
- [Local vs cloud AI](../design/local-vs-cloud-ai.md)
- [Workload profiles](../design/workload-profiles.md)
