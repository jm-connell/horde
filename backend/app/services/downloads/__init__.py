"""The download pipeline: queue, yt-dlp attempt loop, postprocess and library commit.

``services/downloader.py`` re-exports the public names for callers that still
import them from there.

Importing a module of this package has no side effects: ``app.context.build_context``
binds the queue to the attempt loop (the queue itself does not know how a job is run).
"""
