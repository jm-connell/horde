"""The download pipeline: queue, yt-dlp attempt loop, postprocess and library commit.

``services/downloader.py`` re-exports the public names for callers that still
import them from there.

Importing any module of this package binds the process-wide ``download_queue``
to the attempt loop (the queue itself does not know how a job is run).
"""

from . import runner
from .queue import download_queue

download_queue.runner = runner.run_download
