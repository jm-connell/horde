# AI setup

Optional AI powers embeddings (hybrid search, related videos, category shelves), tags, summaries, chapters and chat. Horde talks to **any OpenAI-compatible provider**: you give it a base URL, an API key if the provider needs one, a chat model and an embedding model.

!!! tip "UI controls"
    Everything here is set in the setup wizard or [Settings → AI](../settings/ai.md) → Providers. This page explains which URL to use, the optional bundled Ollama, GPU sizing, and budgets.

## Pick a provider

| You want | Use | Needs |
|----------|-----|-------|
| No GPU, little setup | A cloud provider: **OpenRouter** (one key for most models, reports cost per call), OpenAI, Google Gemini, Mistral, Groq, DeepSeek, Together | An API key |
| Models on your own hardware, server already running | Ollama, LM Studio, llama.cpp `llama-server`, vLLM, LocalAI, … | The server's address |
| Models on this machine, no server yet | The **bundled Ollama** container (below) | A GPU passed through (CPU works, slowly) |

The provider dropdown in Settings only fills in the URL; any other OpenAI-compatible URL works too. Titles, descriptions, captions, notes and chat messages are sent to the provider, so a server you run keeps them on your network.

### Providers without embeddings

Groq, DeepSeek and Anthropic's OpenAI endpoint have no `/v1/embeddings`. Leave the embedding model empty (search indexes stay off), or turn on **Use a different server for embeddings** and point that at one that has them, for example OpenRouter or a local Ollama with `nomic-embed-text`.

## Which URL do I type? (Docker networking)

Horde runs in a container. Inside it, `localhost` / `127.0.0.1` is the **Horde container itself**, not your server, so a URL that works in your browser may not work from Horde.

| Where the AI server runs | URL to use in Horde |
|--------------------------|---------------------|
| The bundled `ollama` service in Horde's compose file | `http://ollama:11434/v1` |
| Another container in the **same** compose project | `http://<service-name>:<port>/v1` |
| On the Docker host itself (Ollama app, LM Studio, …) | `http://host.docker.internal:<port>/v1` |
| Another PC on your network | `http://<that PC's LAN IP>:<port>/v1`, e.g. `http://192.168.1.50:11434/v1` |
| A cloud provider | Its URL from the dropdown, e.g. `https://openrouter.ai/api/v1` |
| Horde run without Docker (local development) | `http://127.0.0.1:<port>/v1` |

Default ports: Ollama **11434**, LM Studio **1234**, llama.cpp **8080**, vLLM **8000**. A bare `http://host:port` gets `/v1` added for you. **Find a server on this machine** under the URL box tries the bundled Ollama and those ports on `host.docker.internal`.

Things that commonly get in the way:

- **`host.docker.internal`** needs `extra_hosts: ["host.docker.internal:host-gateway"]` on the `horde` service. Horde's `docker-compose.yml` has it; add it if you wrote your own compose file.
- **The server only listens on localhost.** Ollama does by default: set `OLLAMA_HOST=0.0.0.0` (systemd: `systemctl edit ollama`, then restart). LM Studio: enable *Serve on local network*. llama.cpp: start with `--host 0.0.0.0`.
- **A firewall** on the AI machine blocks the port from the Docker network or the LAN. Allow the port.
- **A different compose project or network.** Containers only reach each other by service name on a shared network; otherwise use the host's address and published port.

Use **Test** in Settings: it lists the models the server offers, or says why it failed (unreachable, rejected credentials, no API at that path).

## Bundled Ollama ("Run Ollama for me")

```bash
docker compose --profile ai up -d
```

That starts the optional `ollama` service with its models under `OLLAMA_DATA_PATH` (default `./ollama`). Then choose **Run Ollama for me** in the setup wizard, or set the URL to `http://ollama:11434/v1` in Settings. Horde picks models that fit the GPU (below) and asks Ollama to download them; AI jobs wait until they arrive.

`update.sh` keeps the profile on while the `horde-ollama` container exists and carries `OLLAMA_DATA_PATH` over.

### GPU templates

The compose file has commented passthrough snippets for NVIDIA (`deploy.resources`), AMD ROCm (`/dev/kfd`, `/dev/dri`), and Intel (`/dev/dri`) on the `ollama` service. Uncomment the one that matches your host. Without one, Ollama runs on the CPU, which works but is slow.

Horde's **H.264 encode** GPU (for playback compatibility copies) is a separate pass-through on the `horde` service. Settings → System → **GPU** / **None detected** is that container, not Ollama. See [GPU](environment.md#gpu).

## Ollama extras

When the provider URL points at an Ollama server (Horde checks for Ollama's `/api/version` beside `/v1`), Settings → AI shows an **Ollama** section:

- **Download recommended models**: picks chat and embedding models for the GPU and downloads them.
- **Download missing models**: when on, a configured model that is not installed is downloaded automatically.
- **Ollama VRAM (GB)**: tells Horde the GPU size when it cannot read it (Ollama on another PC).

Other servers load whatever model you name; Horde does not manage their models.

## VRAM tiers

Horde sizes Ollama models against the **Ollama machine's** GPU (override → Ollama `/api/info` → same-host probe), not necessarily the Horde host.

| Tier | VRAM | Default embed | Default chat |
|------|------|---------------|--------------|
| **critical** | &lt; 3 GB | `all-minilm` | `llama3.2:1b` |
| **small** | 3–8 GB | `nomic-embed-text` | `qwen2.5:3b` |
| **medium** | 8–16 GB | `mxbai-embed-large` | `qwen2.5:7b` |
| **large** | ≥ 16 GB | `mxbai-embed-large` | `qwen2.5:14b` |
| **unknown** | undetected | `nomic-embed-text` | `qwen2.5:3b` |

## Workload profiles

Profile scales invent/sample intensity and enqueue batch limits for any provider; on Ollama, applying one also picks the tier's models:

| Profile | Intensity multiplier | Notes |
|---------|----------------------|-------|
| **Light** | **0.4×** | Smaller samples, higher category match threshold |
| **Normal** | 1.0× | Default for small/medium |
| **Heavy** | **1.75×** | Larger samples; enqueue limits ×2 |

**Critical** VRAM **locks** the profile to **Light** so models fit. Recommended defaults: critical→light, large→heavy, medium/small→normal.

!!! warning "Reindex after an embedding model change"
    Vectors are model-specific. Changing the embedding model (or the server that runs it, when the model differs) requires rebuilding indexes; Settings offers to. Stale vectors break hybrid search and recommendations.

## Costs and the weekly budget

Only providers that report a cost per call (OpenRouter's `usage.cost`) have costs: Settings → AI → **Costs** then shows the totals, kept locally in `openrouter_usage` (rolling windows). Other providers show no costs.

- Set a **weekly budget** (USD).
- Enable **Stop AI calls when exceeded** to block further calls and **pause the AI queue** when spend ≥ budget.

A budget alone warns in the UI without stopping the queue.

## Environment variables

| Variable | Behavior |
|----------|----------|
| `OPENROUTER_API_KEY` | Overrides the saved key while the provider URL is OpenRouter; never sent elsewhere |
| `OLLAMA_BASE_URL` | Legacy: used when Settings has no provider URL, and when upgrading |
| `OLLAMA_DATA_PATH` | Where the bundled Ollama keeps its models |

## Upgrading from the Ollama / OpenRouter split

Before this change Settings had separate Ollama and OpenRouter panes. On the first start after the upgrade Horde converts them once, keeping model names so nothing is re-indexed:

| Before | After |
|--------|-------|
| OpenRouter on, Tasks *Specialized*, Ollama on | Chat: OpenRouter. Embeddings: the Ollama URL (second server) |
| OpenRouter on, Tasks *All* | Chat and embeddings: OpenRouter |
| Ollama only | Chat and embeddings: the Ollama URL with `/v1` |
| Ollama only, URL left empty (auto-discover) | Horde looks for Ollama at start (compose service, then the Docker host) and saves the first one that answers; if none does, Settings shows no provider until you set one |

## Queue visibility & recovery

Settings → AI → Jobs shows **runnable / deferred / waiting / failed** counts plus a blocked reason when the provider is down. Terminal failures list under **Failed jobs** with Retry / Retry all / Clear failed.

If the provider was offline, waiting jobs resume automatically once it is reachable again (no Horde restart required). See [Troubleshooting — AI provider offline](troubleshooting.md#ai-provider-offline).

## Related

- [AI features guide](../guides/ai-features.md)
- [AI pipeline](../architecture/ai-pipeline.md)
- [Local vs cloud AI](../design/local-vs-cloud-ai.md)
- [Workload profiles](../design/workload-profiles.md)
- [ADR 0017: one OpenAI-compatible provider](../adr/0017-openai-compatible-provider.md)
