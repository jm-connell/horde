"""Entry point for the desktop app: ``python -m app.desktop_entry``.

Runs the same server as the image (``app.main:app`` on ``HOST``/``PORT``), in
process, and treats standard input as a lifeline: the desktop shell holds the
other end of the pipe, so when the shell exits for any reason (quit, crash, a
Task Manager kill, logout) the pipe reaches end of file and the server shuts down
gracefully. No signals are involved, so this works on Windows too, where the
pipe is polled instead of read (see ``_watch_lifeline_windows``).

Lines on standard input are reserved for commands from the shell; for now every
line is ignored.
"""

from __future__ import annotations

import logging
import os
import sys
import threading
import time

import uvicorn

from .config import HOST, PORT

logger = logging.getLogger(__name__)

#: As the image's ``--timeout-graceful-shutdown 10``.
GRACEFUL_SHUTDOWN_SEC = 10
#: How often a non-blocking standard input is polled for end of file.
_POLL_SEC = 0.5


def _watch_lifeline(server: uvicorn.Server, fd: int) -> None:
    """Read standard input until end of file, then ask the server to stop.

    ``os.read`` on the file descriptor, not the buffered reader: a thread blocked
    in the reader holds its lock, and interpreter shutdown then aborts with
    "could not acquire lock" on any stop that is not end of file. Only end of file
    (an empty read) or a read error stops the server, and each says why at
    WARNING, which shows even if it happens before ``app.main`` has configured
    logging (until then only Python's last-resort handler, WARNING and up, runs).
    """
    said_no_data = False
    try:
        while True:
            try:
                chunk = os.read(fd, 4096)
            except BlockingIOError:
                # A non-blocking pipe with nothing in it yet: the shell is still
                # there. Poll instead of treating it as the end.
                if not said_no_data:
                    logger.warning(
                        "standard input is non-blocking; polling it for end of file"
                    )
                    said_no_data = True
                time.sleep(_POLL_SEC)
                continue
            if not chunk:
                logger.warning(
                    "standard input reached end of file (the desktop app closed "
                    "it or exited); stopping"
                )
                return
            # No commands yet: whatever the shell sends is ignored.
    except OSError as exc:
        # A broken pipe or a bad handle means the shell is gone too: stop rather
        # than linger.
        logger.warning(
            "reading standard input failed (%r); stopping", exc, exc_info=True
        )
    finally:
        server.should_exit = True


if sys.platform == "win32":
    import _winapi

    _ERROR_BROKEN_PIPE = 109

    def _watch_lifeline_windows(server: uvicorn.Server) -> None:
        """Poll the standard input pipe for its end; never block in a read.

        On Windows a thread blocked in ``ReadFile`` on a pipe holds that pipe: any
        child process that inherits it (ffmpeg, deno) then hangs in its own
        start-up when it asks what kind of handle its standard input is, and the
        server hangs with it. ``PeekNamedPipe`` answers at once and reports the
        closed pipe as a broken-pipe error, so it is asked every half second.
        The Win32 handle is used directly, not the C runtime's descriptor 0.
        """
        try:
            handle = _winapi.GetStdHandle(_winapi.STD_INPUT_HANDLE)
        except OSError:
            handle = None
        if not handle:
            logger.warning("no standard input handle: serving without a lifeline")
            return
        kind = _winapi.GetFileType(handle)
        first = True
        while True:
            try:
                # (available, left in this message); with a size it would be
                # (data, available, left), so the count is second from the end.
                available = _winapi.PeekNamedPipe(handle, 0)[-2]
                if available:
                    # No commands yet: whatever the shell sends is discarded.
                    _winapi.ReadFile(handle, available)
            except OSError as exc:
                ended = (
                    isinstance(exc, BrokenPipeError)
                    or getattr(exc, "winerror", None) == _ERROR_BROKEN_PIPE
                )
                if ended:
                    logger.warning(
                        "standard input reached end of file (the desktop app "
                        "closed it or exited); stopping (handle type %s)",
                        kind,
                    )
                    break
                if first:
                    # Not a pipe at all (NUL, a console, a file): nothing to watch.
                    logger.warning(
                        "standard input is not a pipe (handle type %s, %r): "
                        "serving without a lifeline",
                        kind,
                        exc,
                    )
                    return
                logger.warning(
                    "reading standard input failed (%r); stopping", exc, exc_info=True
                )
                break
            first = False
            time.sleep(_POLL_SEC)
        server.should_exit = True


def _stdin_fd() -> int | None:
    stdin = sys.stdin
    if stdin is None or stdin.closed:
        return None
    try:
        return stdin.fileno()
    except OSError, ValueError:  # io.UnsupportedOperation is both
        logger.warning("standard input has no file descriptor", exc_info=True)
        return None


def main() -> int:
    config = uvicorn.Config(
        "app.main:app",
        host=HOST,
        port=PORT,
        timeout_graceful_shutdown=GRACEFUL_SHUTDOWN_SEC,
    )
    server = uvicorn.Server(config)
    if sys.platform == "win32":
        threading.Thread(
            target=_watch_lifeline_windows,
            args=(server,),
            name="desktop-lifeline",
            daemon=True,
        ).start()
    else:
        fd = _stdin_fd()
        if fd is None:
            logger.warning("no standard input: serving without a lifeline")
        else:
            threading.Thread(
                target=_watch_lifeline,
                args=(server, fd),
                name="desktop-lifeline",
                daemon=True,
            ).start()
    server.run()
    return 0 if server.started else 1


if __name__ == "__main__":
    sys.exit(main())
