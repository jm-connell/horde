"""GPU-aware workload profiles: VRAM picks models; profile picks intensity."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any, Literal, Optional

WorkloadProfile = Literal["light", "normal", "heavy"]
VramTier = Literal["critical", "small", "medium", "large", "unknown"]

GB = 1024**3
CRITICAL_VRAM = 3 * GB
SMALL_VRAM = 8 * GB
MEDIUM_VRAM = 16 * GB


@dataclass
class GpuInfo:
    name: Optional[str] = None
    vram_total_bytes: Optional[int] = None
    vram_used_bytes: Optional[int] = None
    util_percent: Optional[float] = None
    temp_c: Optional[float] = None


@dataclass
class RuntimeConfig:
    profile: WorkloadProfile
    vram_tier: VramTier
    embed_model: str
    chat_model: str
    invent_sample_size: int
    invent_budget_chars: int
    invent_desc_chars: int
    invent_sub_chars: int
    category_min_score: float
    enqueue_embed_limit: int
    enqueue_tag_limit: int
    recommended_profile: WorkloadProfile
    profile_locked: bool
    lock_reason: Optional[str]
    warning: Optional[str]
    gpu_name: Optional[str]
    vram_total_bytes: Optional[int]

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def probe_nvidia_gpu() -> Optional[dict[str, Any]]:
    """Return NVIDIA GPU stats dict, or None if unavailable."""
    import subprocess

    try:
        result = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=utilization.gpu,temperature.gpu,memory.used,memory.total,name",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            text=True,
            timeout=2.5,
            check=False,
        )
        if result.returncode != 0 or not result.stdout.strip():
            return None
        line = result.stdout.strip().splitlines()[0]
        parts = [p.strip() for p in line.split(",")]
        if len(parts) < 4:
            return None

        def _num(raw: str) -> Optional[float]:
            try:
                return float(raw)
            except ValueError:
                return None

        util = _num(parts[0])
        temp = _num(parts[1])
        mem_used_mib = _num(parts[2])
        mem_total_mib = _num(parts[3])
        name = parts[4] if len(parts) > 4 else None
        return {
            "name": name,
            "util_percent": util,
            "temp_c": temp,
            "vram_used_bytes": int(mem_used_mib * 1024 * 1024)
            if mem_used_mib is not None
            else None,
            "vram_total_bytes": int(mem_total_mib * 1024 * 1024)
            if mem_total_mib is not None
            else None,
        }
    except Exception:  # noqa: BLE001
        return None


def detect_gpu() -> GpuInfo:
    """Best-effort NVIDIA GPU info."""
    raw = probe_nvidia_gpu()
    if not raw:
        return GpuInfo()
    return GpuInfo(
        name=raw.get("name"),
        vram_total_bytes=raw.get("vram_total_bytes"),
        vram_used_bytes=raw.get("vram_used_bytes"),
        util_percent=raw.get("util_percent"),
        temp_c=raw.get("temp_c"),
    )


def vram_tier(gpu: GpuInfo) -> VramTier:
    total = gpu.vram_total_bytes
    if total is None:
        return "unknown"
    if total < CRITICAL_VRAM:
        return "critical"
    if total < SMALL_VRAM:
        return "small"
    if total < MEDIUM_VRAM:
        return "medium"
    return "large"


def recommended_profile_for_tier(tier: VramTier) -> WorkloadProfile:
    if tier == "critical":
        return "light"
    if tier == "large":
        return "heavy"
    if tier == "medium":
        return "normal"
    # small + unknown
    return "normal"


def _models_for_tier(tier: VramTier) -> tuple[str, str]:
    """Embed + chat models that fit the VRAM tier (same across profiles)."""
    if tier == "critical":
        return "all-minilm", "llama3.2:1b"
    if tier == "small":
        return "nomic-embed-text", "qwen2.5:3b"
    if tier == "medium":
        return "mxbai-embed-large", "qwen2.5:7b"
    if tier == "large":
        return "mxbai-embed-large", "qwen2.5:14b"
    # unknown: safe mid defaults
    return "nomic-embed-text", "qwen2.5:3b"


# Base invent intensity by tier at "normal" profile.
_NORMAL_BY_TIER: dict[VramTier, dict[str, int | float]] = {
    "critical": {
        "sample": 40,
        "budget": 12_000,
        "desc": 150,
        "sub": 60,
        "score": 0.60,
        "embed_limit": 2_000,
        "tag_limit": 1_000,
    },
    "small": {
        "sample": 100,
        "budget": 28_000,
        "desc": 300,
        "sub": 120,
        "score": 0.55,
        "embed_limit": 5_000,
        "tag_limit": 2_000,
    },
    "medium": {
        "sample": 120,
        "budget": 36_000,
        "desc": 350,
        "sub": 160,
        "score": 0.55,
        "embed_limit": 10_000,
        "tag_limit": 5_000,
    },
    "large": {
        "sample": 150,
        "budget": 48_000,
        "desc": 400,
        "sub": 200,
        "score": 0.55,
        "embed_limit": 20_000,
        "tag_limit": 10_000,
    },
    "unknown": {
        "sample": 80,
        "budget": 24_000,
        "desc": 250,
        "sub": 100,
        "score": 0.55,
        "embed_limit": 5_000,
        "tag_limit": 2_000,
    },
}


def _scale_intensity(
    base: dict[str, int | float], profile: WorkloadProfile
) -> dict[str, int | float]:
    if profile == "light":
        mult = 0.4
        score_delta = 0.05
        limit_mult = 0.4
    elif profile == "heavy":
        mult = 1.75
        score_delta = -0.05
        limit_mult = 2.0
    else:
        mult = 1.0
        score_delta = 0.0
        limit_mult = 1.0

    sample = int(base["sample"] * mult)
    budget = int(base["budget"] * mult)
    desc = int(base["desc"] * (0.7 if profile == "light" else 1.0 if profile == "normal" else 1.2))
    sub = int(base["sub"] * (0.5 if profile == "light" else 1.0 if profile == "normal" else 1.4))
    score = float(base["score"]) + score_delta
    score = max(0.20, min(0.90, score))
    embed_limit = max(500, int(base["embed_limit"] * limit_mult))
    tag_limit = max(250, int(base["tag_limit"] * limit_mult))

    # Caps so Heavy on large GPUs can go big without unbounded prompts.
    sample = max(20, min(200, sample))
    budget = max(8_000, min(60_000, budget))
    desc = max(80, min(500, desc))
    sub = max(0 if profile == "light" else 40, min(280, sub))

    return {
        "sample": sample,
        "budget": budget,
        "desc": desc,
        "sub": sub,
        "score": score,
        "embed_limit": embed_limit,
        "tag_limit": tag_limit,
    }


def normalize_profile(raw: Any) -> WorkloadProfile:
    value = str(raw or "normal").strip().lower()
    if value in ("light", "normal", "heavy"):
        return value  # type: ignore[return-value]
    return "normal"


def resolve_runtime(
    profile: WorkloadProfile | str | None = None,
    gpu: Optional[GpuInfo] = None,
) -> RuntimeConfig:
    gpu = gpu if gpu is not None else detect_gpu()
    tier = vram_tier(gpu)
    recommended = recommended_profile_for_tier(tier)
    requested = normalize_profile(profile)

    profile_locked = tier == "critical"
    lock_reason: Optional[str] = None
    if profile_locked:
        lock_reason = (
            "GPU VRAM is under 3 GB (or critically limited). "
            "Only the Light workload is available so models can fit."
        )
        effective: WorkloadProfile = "light"
    else:
        effective = requested

    warning: Optional[str] = None
    if effective == "heavy" and tier in ("small", "medium", "unknown"):
        warning = (
            "Heavy workload fits this GPU’s models but will take longer — "
            "larger invent samples and deeper indexing, not a bigger model."
        )

    embed_model, chat_model = _models_for_tier(tier)
    intensity = _scale_intensity(_NORMAL_BY_TIER[tier], effective)

    return RuntimeConfig(
        profile=effective,
        vram_tier=tier,
        embed_model=embed_model,
        chat_model=chat_model,
        invent_sample_size=int(intensity["sample"]),
        invent_budget_chars=int(intensity["budget"]),
        invent_desc_chars=int(intensity["desc"]),
        invent_sub_chars=int(intensity["sub"]),
        category_min_score=float(intensity["score"]),
        enqueue_embed_limit=int(intensity["embed_limit"]),
        enqueue_tag_limit=int(intensity["tag_limit"]),
        recommended_profile=recommended,
        profile_locked=profile_locked,
        lock_reason=lock_reason,
        warning=warning,
        gpu_name=gpu.name,
        vram_total_bytes=gpu.vram_total_bytes,
    )


def settings_patch_for_runtime(runtime: RuntimeConfig) -> dict[str, Any]:
    """Fields to persist when applying a workload profile."""
    return {
        "workload_profile": runtime.profile,
        "embed_model": runtime.embed_model,
        "chat_model": runtime.chat_model,
        "category_min_score": runtime.category_min_score,
    }
