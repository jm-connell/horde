import threading
import time

from app.services import ytdlp_common


def test_interactive_extract_jumps_background_waiters():
    ytdlp_common._extract_held = False
    ytdlp_common._extract_waiters.clear()
    ytdlp_common._extract_waiter_seq = 0

    order: list[str] = []
    ytdlp_common._acquire_extract_gate(ytdlp_common.EXTRACT_PRIORITY_DOWNLOAD)

    def background() -> None:
        ytdlp_common._acquire_extract_gate(ytdlp_common.EXTRACT_PRIORITY_BACKGROUND)
        order.append("bg")
        ytdlp_common._release_extract_gate()

    def interactive() -> None:
        ytdlp_common._acquire_extract_gate(ytdlp_common.EXTRACT_PRIORITY_INTERACTIVE)
        order.append("fg")
        ytdlp_common._release_extract_gate()

    bg = threading.Thread(target=background)
    fg = threading.Thread(target=interactive)
    bg.start()
    time.sleep(0.05)
    fg.start()
    time.sleep(0.05)
    ytdlp_common._release_extract_gate()
    bg.join(timeout=2)
    fg.join(timeout=2)
    try:
        assert order == ["fg", "bg"]
    finally:
        ytdlp_common._extract_held = False
        ytdlp_common._extract_waiters.clear()
