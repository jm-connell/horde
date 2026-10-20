"""Soak-test live playback against a real YouTube broadcast, without a browser.

Usage, inside the container (or from ``backend/`` with ``PYTHONPATH=.``)::

    docker compose exec horde python -m app.live_probe "https://www.youtube.com/watch?v=VIDEO_ID" --minutes 60

Runs the same ``LiveSession`` the ``/api/live`` proxy uses and plays one
variant like a player would: it re-reads the playlist every half target
duration and downloads every new segment. It prints what a viewer would have
felt: segments fetched, failures, how long the edge stalled, URL refreshes and
how far back the DVR window reaches. Nothing is written to the library or the
database. Exit status 0 when every segment arrived.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import re
import statistics
import sys
import tempfile
import time
from typing import Any

import httpx

_ID_RE = re.compile(r"(?:v=|youtu\.be/|/live/)([A-Za-z0-9_-]{11})")


class _Counter(logging.Handler):
    def __init__(self) -> None:
        super().__init__(logging.INFO)
        self.refreshes: list[str] = []

    def emit(self, record: logging.LogRecord) -> None:
        msg = record.getMessage()
        if msg.startswith("refreshing live stream"):
            self.refreshes.append(msg)
            print(f"  [{time.strftime('%H:%M:%S')}] {msg}")
        elif "DVR" in msg or "has ended" in msg:
            print(f"  [{time.strftime('%H:%M:%S')}] {msg}")


async def _run(url: str, minutes: float, variant_pick: str | None) -> int:
    from app.services import stream_preview
    from app.services.live.sessions import (
        LiveNotAvailable,
        LiveSegmentMissing,
        LiveSession,
        LiveUpstreamError,
    )

    match = _ID_RE.search(url)
    if not match:
        print("Could not find a video id in that URL", file=sys.stderr)
        return 2
    video_id = match.group(1)

    counter = _Counter()
    logging.getLogger("app.services.live.sessions").addHandler(counter)
    logging.getLogger("app.services.live.sessions").setLevel(logging.INFO)

    client = httpx.AsyncClient(
        timeout=httpx.Timeout(connect=10.0, read=20.0, write=10.0, pool=10.0),
        follow_redirects=True,
    )

    async def fetch(u: str, headers: dict[str, str], stream: bool) -> httpx.Response:
        request = client.build_request("GET", u, headers=headers)
        return await client.send(request, stream=stream)

    async def resolve(u: str, force: bool) -> dict[str, Any]:
        return await asyncio.to_thread(
            stream_preview._extract_preview_info, u, force=force
        )

    started = time.time()
    try:
        info = await resolve(f"https://www.youtube.com/watch?v={video_id}", False)
        session = LiveSession.from_info(
            video_id, info, fetcher=fetch, resolver=resolve, dvr_window_sec=4 * 3600
        )
    except LiveNotAvailable as exc:
        print(f"Not playable as live: {exc}")
        return 2
    print(f"Extracted in {time.time() - started:.1f}s: {session.title!r}")
    keys = list(session.variants)
    print(
        "Variants:",
        ", ".join(f"{k} ({session.variants[k].upstream.info.height}p)" for k in keys),
    )
    key = variant_pick if variant_pick in session.variants else keys[-1]
    print(f"Playing variant {key} for {minutes:g} minutes\n")

    deadline = time.time() + minutes * 60
    fetched: set[int] = set()
    seg_ok = seg_fail = playlist_fail = 0
    seg_times: list[float] = []
    longest_stall = 0.0
    last_new = time.time()
    next_sq: int | None = None
    next_report = time.time() + 60
    try:
        while time.time() < deadline and not session.ended:
            try:
                body = await session.media(key)
            except (LiveUpstreamError, httpx.HTTPError) as exc:
                playlist_fail += 1
                print(f"  playlist refresh failed: {exc}")
                await asyncio.sleep(2)
                continue
            sqs = [int(s) for s in re.findall(r"/(\d+)\.ts", body)]
            if not sqs:
                await asyncio.sleep(1)
                continue
            if next_sq is None:
                next_sq = sqs[-1] - 2  # start near the edge like a player
            for sq in [s for s in sqs if s >= next_sq and s not in fetched]:
                t0 = time.time()
                try:
                    resp = await session.segment(key, sq)
                    size = len(await resp.aread())
                    await resp.aclose()
                    seg_ok += 1
                    done = time.time()
                    seg_times.append(done - t0)
                    longest_stall = max(longest_stall, done - last_new)
                    last_new = done
                    fetched.add(sq)
                    next_sq = sq + 1
                    if size == 0:
                        print(f"  segment {sq} was empty")
                except (LiveSegmentMissing, LiveUpstreamError, httpx.HTTPError) as exc:
                    seg_fail += 1
                    print(f"  segment {sq} failed: {exc}")
                    break
            target = session.variants[key].target_duration or 5.0
            await asyncio.sleep(max(0.5, target / 2))
            if time.time() >= next_report:
                next_report += 60
                elapsed = int(time.time() - started)
                dvr = (
                    f"DVR back to sq {session.dvr_floor}"
                    if session.template_ok
                    else "no DVR beyond the playlist"
                )
                print(
                    f"[{elapsed // 60:>3} min] segments ok={seg_ok} failed={seg_fail}, "
                    f"refreshes={len(counter.refreshes)}, {dvr}"
                )
        # One backfilled segment proves scrubbing back works.
        dvr_ok = None
        if session.template_ok and session.dvr_floor is not None:
            try:
                resp = await session.segment(key, session.dvr_floor + 1)
                dvr_ok = resp.status_code < 400
                await resp.aclose()
            except LiveSegmentMissing, LiveUpstreamError, httpx.HTTPError:
                dvr_ok = False
    finally:
        session.close()
        await client.aclose()

    head = session.variants[key].head_sq or 0
    target = session.variants[key].target_duration or 5.0
    print("\n=== Summary ===")
    print(f"Duration:            {(time.time() - started) / 60:.1f} min")
    print(f"Segments:            {seg_ok} ok, {seg_fail} failed")
    print(f"Playlist failures:   {playlist_fail}")
    print(f"URL refreshes:       {len(counter.refreshes)}")
    if seg_times:
        print(
            f"Segment fetch time:  median {statistics.median(seg_times):.2f}s, "
            f"max {max(seg_times):.2f}s (segment length {target:g}s)"
        )
    print(f"Longest edge stall:  {longest_stall:.1f}s")
    if session.template_ok and session.dvr_floor is not None:
        back = (head - session.dvr_floor) * target / 60
        print(
            f"DVR window:          {back:.0f} min back; backfilled segment ok: {dvr_ok}"
        )
    else:
        print("DVR window:          only what this session saw")
    print(f"Broadcast ended:     {session.ended}")
    return 0 if seg_fail == 0 and playlist_fail == 0 else 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("url", help="a YouTube watch URL of a broadcast that is live")
    parser.add_argument("--minutes", type=float, default=30.0)
    parser.add_argument("--variant", help="format id to play (default: the highest)")
    args = parser.parse_args()
    # Outside the container, never fall back to ./data in the working directory.
    os.environ.setdefault("DATA_DIR", tempfile.mkdtemp(prefix="horde-live-probe-"))
    os.environ.setdefault("DOWNLOADS_DIR", tempfile.mkdtemp(prefix="horde-live-probe-"))
    logging.basicConfig(level=logging.WARNING, format="%(message)s")
    return asyncio.run(_run(args.url, args.minutes, args.variant))


if __name__ == "__main__":
    sys.exit(main())
