"""Optional AI layer (Ollama embeddings + optional OpenRouter LLM)."""

from . import worker
from .worker import enqueue_for_video, start_ai_worker, stop_ai_worker

__all__ = ["enqueue_for_video", "start_ai_worker", "stop_ai_worker", "worker"]
