"""Benchmark library queries and vector search on a generated library.

Usage (from ``backend/``)::

    PYTHONPATH=. python scripts/bench_library.py --videos 10000 --chunks 6

Builds a throw-away ``DATA_DIR`` (never touches a real library), fills it with
synthetic videos, tags, embeddings and watch-agnostic rows through plain SQL,
then times the hot read paths: keyword search, tag filter, tag listing,
YouTube-id lookup and embedding nearest-neighbour search. Medians in
milliseconds are printed as a table.
"""

from __future__ import annotations

import argparse
import json
import os
import random
import shutil
import sqlite3
import statistics
import string
import sys
import tempfile
import time
from pathlib import Path

_ALPHABET = string.ascii_letters + string.digits + "_-"


def _build(db_path: Path, videos: int, chunks: int, dim: int, seed: int) -> list[str]:
    import numpy as np

    rng = random.Random(seed)  # noqa: S311 - synthetic benchmark data
    words = [
        "".join(rng.choices(string.ascii_lowercase, k=rng.randint(4, 9)))
        for _ in range(3000)
    ]
    tags = [f"tag{n}" for n in range(400)] + words[:100]
    channels = [f"Channel {n}" for n in range(120)]
    yt_ids: list[str] = []
    con = sqlite3.connect(db_path)
    con.execute("PRAGMA foreign_keys=ON")
    rows = []
    for i in range(1, videos + 1):
        yt = "".join(rng.choices(_ALPHABET, k=11))
        yt_ids.append(yt)
        title = " ".join(rng.choices(words, k=rng.randint(3, 8)))
        desc = " ".join(rng.choices(words, k=rng.randint(30, 90)))
        vtags = rng.sample(tags, rng.randint(2, 9))
        # Half of the rows carry the id only in the file name, half only in the URL.
        path = (
            f"{rng.choice(channels)}/{title[:30]} [{yt}].mp4" if i % 2 else f"v/{i}.mp4"
        )
        url = None if i % 2 else f"https://www.youtube.com/watch?v={yt}"
        rows.append(
            (
                i,
                title,
                rng.choice(channels),
                json.dumps(vtags),
                desc,
                path,
                url,
                "2024-01-01 00:00:00",
            )
        )
    con.executemany(
        "INSERT INTO videos (id, title, channel, tags, description, file_path, source_url,"
        " added_at, subtitles, last_position_sec, needs_review, status,"
        " subtitles_pending, subtitles_fetch_attempts, source_chapters, is_hdr,"
        " title_is_custom, description_is_custom)"
        " VALUES (?,?,?,?,?,?,?,?,'[]',0,0,'ready',0,0,'[]',0,0,0)",
        rows,
    )
    nprng = np.random.default_rng(seed)
    emb = []
    for i in range(1, videos + 1):
        mat = nprng.standard_normal((chunks, dim)).astype("float32")
        for c in range(chunks):
            emb.append(
                (i, c - 1, "bench", dim, mat[c].tobytes(), "h", "2024-01-01 00:00:00")
            )
    con.executemany(
        "INSERT INTO video_embeddings (video_id, chunk_index, model, dim, vector,"
        " content_hash, updated_at) VALUES (?,?,?,?,?,?,?)",
        emb,
    )
    con.commit()
    con.close()
    return yt_ids


def _time(fn, runs: int) -> float:
    samples = []
    for _ in range(runs):
        t0 = time.perf_counter()
        fn()
        samples.append((time.perf_counter() - t0) * 1000)
    return statistics.median(samples)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--videos", type=int, default=10_000)
    parser.add_argument(
        "--chunks", type=int, default=6, help="embedding rows per video"
    )
    parser.add_argument("--dim", type=int, default=768)
    parser.add_argument("--runs", type=int, default=7)
    parser.add_argument("--seed", type=int, default=1)
    args = parser.parse_args()

    data_dir = Path(tempfile.mkdtemp(prefix="horde-bench-"))
    os.environ["DATA_DIR"] = str(data_dir)
    os.environ.setdefault("DOWNLOADS_DIR", str(data_dir / "downloads"))
    try:
        sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
        from sqlmodel import Session

        from app.context import get_engine
        from app.database import init_db
        from app.models import Video
        from app.services import library
        from app.services.ai import embeddings

        init_db()
        t0 = time.perf_counter()
        yt_ids = _build(
            data_dir / "horde.db", args.videos, args.chunks, args.dim, args.seed
        )
        print(
            f"generated {args.videos} videos / {args.videos * args.chunks} vectors "
            f"in {time.perf_counter() - t0:.1f}s",
            flush=True,
        )

        import numpy as np

        query = (
            np.random.default_rng(99)
            .standard_normal(args.dim)
            .astype("float32")
            .tolist()
        )
        with Session(get_engine()) as s:
            first = s.get(Video, 500)
            w1, w2 = first.title.split()[0], first.title.split()[1]
            cases = {
                "search 1 word": lambda: library.query_videos(s, q=w1),
                "search 2 words": lambda: library.query_videos(s, q=f"{w1} {w2}"),
                "search no match": lambda: library.query_videos(s, q="zzzzqqqq"),
                "tag filter (rare)": lambda: library.query_videos(s, tag="tag7"),
                "tag filter (+channel sort)": lambda: library.query_videos(
                    s, tag="tag7", sort="title", order="asc"
                ),
                "all_tags": lambda: library.all_tags(s),
                "tag_stats": lambda: library.tag_stats(s),
                "youtube id (in path)": lambda: library.find_video_by_youtube_id(
                    s, yt_ids[0]
                ),
                "youtube id (url only)": lambda: library.find_video_by_youtube_id(
                    s, yt_ids[1]
                ),
                "youtube id (miss)": lambda: library.find_video_by_youtube_id(
                    s, "AAAAAAAAAAA"
                ),
                "vector search top 24": lambda: embeddings.similar_video_hits(
                    s, query, limit=24
                ),
            }
            print(f"{'case':32} {'median ms':>10}")
            for name, fn in cases.items():
                if name.startswith("vector"):
                    # First call: with the matrix cache this includes building it.
                    print(
                        f"{name + ' (first call)':32} {_time(fn, 1):10.1f}", flush=True
                    )
                runs = 3 if name.startswith("vector") else args.runs
                print(f"{name:32} {_time(fn, runs):10.1f}", flush=True)
    finally:
        shutil.rmtree(data_dir, ignore_errors=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
