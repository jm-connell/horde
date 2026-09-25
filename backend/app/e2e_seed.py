"""Reset the database to a fixed library for browser tests.

Imported only when ``HORDE_E2E`` is set. The seeded library has no YouTube URLs,
AI is off, and download dispatch is a no-op, so the suite never calls YouTube,
OpenRouter, or Ollama.
"""

from __future__ import annotations

import base64
import json
import shutil
from datetime import datetime, timedelta, timezone
from pathlib import Path

# Short silent MP4 so the watch page mounts player chrome without a decode error.
# Long enough that autoplay does not finish and start the up-next countdown.
_MEDIA_BYTES = base64.b64decode(
    "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CC+c//7aplgD8wAAAA1BnoZFESwXzn8AAJuBAAAACwGepXRBfOcAAJuBAAAACwGep2pBfOcAAJuAAAAAE0GarEmoQWyZTAgvnP/+2qZYA/IAAAANQZ7KRRUsF85/AACbgQAAAAsBnul0QXznAACbgAEYIAcBGCAHARggBwEYIAcAAAALAZ7rakF85wAAm4ABGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHAAAAE0Ga8EmoQWyZTAgvnP/+2qZYA/MBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwAAAA1Bnw5FFSwXzn8AAJuBARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcAAAALAZ8tdEF85wAAm4EBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwAAAAsBny9qQXznAACbgAEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHAAAAE0GbM0moQWyZTAgvnP/+2qZYA/IBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHAAAADUGfUUUVLBfOfwAAm4EBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwAAAAsBn3JqQXznAACbgAEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBw=="
)

from sqlmodel import SQLModel

from .e2e_mode import enabled


def prepare(mode: str) -> None:
    if not enabled():
        raise RuntimeError("e2e seed refused: HORDE_E2E is not set")

    from .config import DATA_DIR, DOWNLOADS_DIR
    from .database import engine, init_db
    from . import models  # noqa: F401 — register tables
    from .services import downloader

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    _empty_dir(DOWNLOADS_DIR)
    for extra in ("thumbnails", "sprites", "backgrounds", "fonts"):
        _empty_dir(DATA_DIR / extra)

    SQLModel.metadata.drop_all(engine)
    init_db()

    app_mode = mode == "app"
    _write_settings(DATA_DIR, setup_completed=app_mode)
    _reset_queue(downloader)

    if not app_mode:
        return

    _seed_library(DOWNLOADS_DIR)


def _empty_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)
    for child in path.iterdir():
        if child.is_dir():
            shutil.rmtree(child)
        else:
            child.unlink()


def _write_settings(data_dir: Path, *, setup_completed: bool) -> None:
    payload = {
        "setup_completed": setup_completed,
        "download_queue_paused": False,
        "direct_youtube_search": False,
        "youtube_video_search": False,
        "channel_catalog_enabled": False,
        "ai": {
            "enabled": False,
            "openrouter_enabled": False,
            "openrouter_api_key": "",
        },
        # Non-empty ui skips the client's first-visit settings migration, which
        # would otherwise PATCH defaults over whatever a test just saved.
        "ui": {
            "preview_muted": False,
            "show_card_dates": True,
            "show_description": True,
            "default_library_sort": "added_at",
        },
    }
    (data_dir / "app_settings.json").write_text(json.dumps(payload, indent=2))


def _reset_queue(downloader) -> None:
    queue = downloader.download_queue
    with queue._lock:
        queue._global_paused = False
        queue._running.clear()
        queue._held.clear()
        queue._restart_ids.clear()
        for event in queue._cancel_events.values():
            event.set()
        queue._cancel_events.clear()
    downloader.progress_store.clear()


def _seed_library(downloads: Path) -> None:
    from sqlmodel import Session

    from .database import engine
    from .models import (
        DownloadJob,
        JobStatus,
        Playlist,
        PlaylistItem,
        PlaylistSource,
        Video,
        VideoStatus,
    )

    now = datetime.now(timezone.utc).replace(second=0, microsecond=0)
    yesterday = now - timedelta(days=1)
    published = datetime(2024, 5, 14, 12, tzinfo=timezone.utc)
    chapters = json.dumps(
        [
            {"start_sec": 0, "title": "Cold open"},
            {"start_sec": 42, "title": "Main theme"},
        ]
    )

    def video(**fields) -> Video:
        rel = fields["file_path"]
        dest = downloads / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(_MEDIA_BYTES)
        return Video(
            tags=fields.pop("tags", "[]"),
            status=fields.pop("status", VideoStatus.ready),
            duration_sec=fields.pop("duration_sec", 120.0),
            file_size=fields.pop("file_size", 256),
            **fields,
        )

    with Session(engine) as session:
        aurora = video(
            title="Aurora Drift",
            channel="Northwind",
            tags=json.dumps(["ambient", "field"]),
            description="Aurora over the ridge line.",
            notes="Watch when it is quiet.",
            file_path="Northwind/2024/Aurora Drift.mp4",
            duration_sec=180,
            file_size=4_000_000,
            width_px=1920,
            height_px=1080,
            view_count=1200,
            published_at=published,
            last_position_sec=40,
            last_watched_at=now,
            source_chapters=chapters,
        )
        harbor = video(
            title="Harbor Lights",
            channel="Northwind",
            tags=json.dumps(["ambient"]),
            description="Boats at dusk.",
            file_path="Northwind/2024/Harbor Lights.mp4",
            duration_sec=90,
            file_size=2_000_000,
            height_px=720,
            last_position_sec=15,
            last_watched_at=yesterday,
        )
        cedar = video(
            title="Cedar Notes",
            channel="Northwind",
            tags=json.dumps(["ambient"]),
            file_path="Northwind/2024/Cedar Notes.mp4",
            duration_sec=200,
            height_px=1080,
        )
        paper = video(
            title="Paper Kites",
            channel="Northwind",
            tags=json.dumps(["ambient"]),
            file_path="Northwind/2024/Paper Kites.mp4",
            duration_sec=60,
            height_px=480,
        )
        kiln = video(
            title="Kiln fire",
            channel="Kiln",
            tags=json.dumps(["craft"]),
            description="A short firing.",
            file_path="Kiln/2024/Kiln fire.mp4",
            duration_sec=300,
            height_px=1080,
        )
        inbox = video(
            title="Unreviewed drop",
            channel=None,
            file_path="inbox/Unreviewed drop.mp4",
            needs_review=True,
            duration_sec=15,
            file_size=512,
        )
        session.add(aurora)
        session.add(harbor)
        session.add(cedar)
        session.add(paper)
        session.add(kiln)
        session.add(inbox)
        session.commit()
        session.refresh(aurora)
        session.refresh(harbor)
        session.refresh(kiln)

        playlist = Playlist(
            name="Evening set",
            source_type=PlaylistSource.user,
            position=0,
        )
        session.add(playlist)
        session.commit()
        session.refresh(playlist)
        session.add(
            PlaylistItem(playlist_id=playlist.id, video_id=aurora.id, position=0)
        )
        session.add(
            PlaylistItem(playlist_id=playlist.id, video_id=harbor.id, position=1)
        )
        session.add(
            DownloadJob(
                url="https://example.invalid/queued-night-drive",
                quality_preset="1080p",
                status=JobStatus.queued,
                title="Queued night drive",
                channel="Northwind",
                progress=0,
            )
        )
        session.add(
            DownloadJob(
                url="https://example.invalid/failed-extract",
                quality_preset="1080p",
                status=JobStatus.error,
                title="Failed extract",
                channel="Northwind",
                error="Sign in to confirm you're not a bot",
                error_kind="bot",
                progress=0,
            )
        )
        session.add(
            DownloadJob(
                url="https://example.invalid/finished-kiln",
                quality_preset="1080p",
                status=JobStatus.completed,
                title="Finished kiln tour",
                channel="Kiln",
                video_id=kiln.id,
                progress=1,
            )
        )
        session.commit()
