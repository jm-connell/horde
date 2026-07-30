# Workload profiles

Horde sizes **Ollama** models and recommendation/index intensity from the **Ollama machine’s VRAM**, not necessarily the Docker host’s GPU. You pick a workload profile — **Light**, **Normal**, or **Heavy** — and the runtime resolves embed/chat models plus invent limits.

## VRAM tiers

| Tier | Approximate VRAM | Default models (embed + chat) | Recommended profile |
|------|------------------|-------------------------------|---------------------|
| **critical** | &lt; 3 GB | `all-minilm` + `llama3.2:1b` | **Light only** (locked) |
| **small** | 3–8 GB | `nomic-embed-text` + `qwen2.5:3b` | Normal |
| **medium** | 8–16 GB | `mxbai-embed-large` + `qwen2.5:7b` | Normal |
| **large** | ≥ 16 GB | `mxbai-embed-large` + `qwen2.5:14b` | Heavy |
| **unknown** | undetected | `nomic-embed-text` + `qwen2.5:3b` | Normal (conservative) |

Detection order: Settings **VRAM override (GB)** → Ollama `/api/info` → same-host local GPU probe (NVIDIA / AMD / DRM) → unknown.

!!! tip "Ollama on another PC"
    If Ollama runs on a different machine and VRAM cannot be read, set **Settings → AI → Ollama VRAM (GB)** so models match that GPU (for example `12` for a 12 GB card).

## Profiles: light / normal / heavy

Models are chosen by **tier**. Profiles scale **intensity**:

| Knob | Light | Normal | Heavy |
|------|-------|--------|-------|
| Invent sample / prompt budget | ~0.4× | 1× | ~1.75× |
| Description / subtitle chars | reduced | baseline | expanded |
| Category min score | slightly higher (stricter) | baseline | slightly lower (looser) |
| Embed / tag enqueue caps | ~0.4× | 1× | ~2× |

Caps keep Heavy from building unbounded prompts even on large GPUs.

## Critical → Light only

When the tier is **critical** (&lt; 3 GB), the UI/runtime **locks** the profile to **Light**. Larger profiles would try to run models that do not fit and thrash the machine. The lock reason is surfaced in AI status so it is obvious why Normal/Heavy are unavailable.

## Applying a profile

Saving a workload profile patches AI settings with the resolved `embed_model`, `chat_model`, `category_min_score`, and `workload_profile`. With auto-pull enabled, stock default models may upgrade when a larger GPU is detected; custom model names are left alone.

## Related

- [Local vs cloud AI](local-vs-cloud-ai.md)
- [Single-flight AI](single-flight-ai.md)
- [AI setup](../ops/ai-setup.md)
- Implementation: `backend/app/services/ai/workload.py`
