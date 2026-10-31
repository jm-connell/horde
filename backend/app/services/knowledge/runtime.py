"""Ask's per-instance state, held on ``AppContext.knowledge``."""

from __future__ import annotations

import threading
from dataclasses import dataclass, field

from .vectors import VectorCache


@dataclass
class KnowledgeRuntime:
    #: Set to cut the worker's pause short (a channel was added or resumed).
    wake: threading.Event = field(default_factory=threading.Event)
    #: Passage vectors per channel for semantic search.
    vectors: VectorCache = field(default_factory=VectorCache)
