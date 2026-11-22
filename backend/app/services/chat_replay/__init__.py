"""Chat replay of past livestreams, read from YouTube while someone watches.

Nothing is saved: the watch page asks for chat around the playback position,
the server reads just that stretch from YouTube's chat replay endpoints and
keeps recent stretches in memory (``ChatReplayRuntime`` on the ``AppContext``).

* ``parse``: YouTube's chat JSON into small, bounded ``ChatItem`` values.
* ``youtube``: the network reads (watch page, chat page, chunk requests).
* ``runtime``: tokens and chunks in memory, per-video locks, the rate-limit pause.
* ``service``: ``read_at`` / ``read_next`` for the API.
"""

from __future__ import annotations
