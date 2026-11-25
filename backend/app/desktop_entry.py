"""Entry point for the desktop app: ``python -m app.desktop_entry``.

Runs the same server as the image (``app.main:app`` on ``HOST``/``PORT``), in
process, and treats standard input as a lifeline: the desktop shell holds the
other end of the pipe, so when the shell exits for any reason (quit, crash, a
Task Manager kill, logout) the pipe reaches end of file and the server shuts down
gracefully. No signals are involved, so this works the same on Windows.

Lines on standard input are reserved for commands from the shell; for now every
line is ignored.
"""

from __future__ import annotations

import io
import logging
import sys
import threading
from typing import BinaryIO

import uvicorn

from .config import HOST, PORT

logger = logging.getLogger(__name__)

#: As the image's ``--timeout-graceful-shutdown 10``.
GRACEFUL_SHUTDOWN_SEC = 10


def _watch_lifeline(server: uvicorn.Server, stream: BinaryIO | io.RawIOBase) -> None:
    """Read lines until end of file, then ask the server to stop."""
    try:
        while stream.readline():
            pass  # No commands yet: unknown lines are ignored.
        logger.info("the desktop app closed standard input; stopping")
    except OSError, ValueError:
        # A broken pipe means the shell is gone too: stop rather than linger.
        logger.warning("reading standard input failed; stopping", exc_info=True)
    finally:
        server.should_exit = True


def main() -> int:
    config = uvicorn.Config(
        "app.main:app",
        host=HOST,
        port=PORT,
        timeout_graceful_shutdown=GRACEFUL_SHUTDOWN_SEC,
    )
    server = uvicorn.Server(config)
    stdin = sys.stdin
    if stdin is None or stdin.closed:
        logger.warning("no standard input: serving without a lifeline")
    else:
        # The raw file, not the buffered reader: a thread blocked in the reader
        # holds its lock, and interpreter shutdown then aborts with "could not
        # acquire lock" on any stop that is not end of file.
        reader = stdin.buffer
        stream = reader.raw if isinstance(reader, io.BufferedReader) else reader
        threading.Thread(
            target=_watch_lifeline,
            args=(server, stream),
            name="desktop-lifeline",
            daemon=True,
        ).start()
    server.run()
    return 0 if server.started else 1


if __name__ == "__main__":
    sys.exit(main())
