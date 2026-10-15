"""Optional AI layer (Ollama embeddings + optional OpenRouter LLM)."""

from . import worker
from .worker import create_workers, enqueue_for_video, recover_ai_jobs

__all__ = [
    "create_workers",
    "enqueue_for_video",
    "recover_ai_jobs",
    "worker",
]
