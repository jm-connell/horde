"""Optional AI layer (Ollama today; provider interface for future backends)."""

from .worker import enqueue_for_video, start_ai_worker, stop_ai_worker

__all__ = ["enqueue_for_video", "start_ai_worker", "stop_ai_worker"]
