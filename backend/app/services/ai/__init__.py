"""Optional AI layer over any OpenAI-compatible provider (chat and embeddings)."""

from . import worker
from .worker import create_workers, enqueue_for_video, recover_ai_jobs

__all__ = [
    "create_workers",
    "enqueue_for_video",
    "recover_ai_jobs",
    "worker",
]
