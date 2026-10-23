"""Reset the database to a fixed library for browser tests.

Imported only when ``HORDE_E2E`` is set. The seeded library has no YouTube URLs,
AI is off, and download dispatch is a no-op, so the suite never calls YouTube,
OpenRouter, or Ollama.
"""

from __future__ import annotations

import base64
import json
import shutil
from datetime import UTC, datetime, timedelta
from pathlib import Path

from sqlalchemy.engine import Engine
from sqlmodel import SQLModel

from .context import AppContext

# Short silent clip so the watch page mounts player chrome without a decode error.
# Long enough (20 s) that autoplay does not finish and start the up-next countdown.
#
# The video track is VP9, not H.264: every Chromium build (including the
# codec-less builds used in CI containers) decodes VP9, whereas H.264 needs
# proprietary codecs. Regenerate with:
#   ffmpeg -f lavfi -i color=c=0x1a2540:s=160x90:r=5:d=20 \
#     -f lavfi -i anullsrc=r=8000:cl=mono -t 20 -c:v libvpx-vp9 -b:v 20k \
#     -crf 40 -g 25 -deadline good -cpu-used 8 -pix_fmt yuv420p \
#     -c:a aac -b:a 8k -movflags +faststart seed.mp4
# Specs that need H.264 specifically must say so; none do today.
_MEDIA_BYTES = base64.b64decode(
    "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AAAAAgAAAAEAAABGAAAAAQAAAAEAAABHAAAAAgAAAAEAAABIAAAAAQAAAAEAAABJAAAAAgAAAAEAAABLAAAAAQAAAAEAAABMAAAAAgAAAAEAAABNAAAAAQAAAAEAAABOAAAAAgAAAAEAAABPAAAAAQAAAAEAAABQAAAAAgAAAAEAAABRAAAAAQAAAAEAAABSAAAAAgAAAAEAAABUAAAAAQAAAAEAAABVAAAAAgAAAAEAAABWAAAAAQAAAAEAAABXAAAAAgAAAAEAAABYAAAAAQAAAAEAAABZAAAAAgAAAAEAAABbAAAAAQAAAAEAAABcAAAAAgAAAAEAAABdAAAAAQAAAAEAAABeAAAAAgAAAAEAAABfAAAAAQAAAAEAAABgAAAAAgAAAAEAAABhAAAAAQAAAAEAAABiAAAAAgAAAAEAAABkAAAAAQAAAAEAAABlAAAAAgAAAAEAAAKMc3RzegAAAAAAAAAAAAAAngAAABUAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAABpHN0Y28AAAAAAAAAZQAAELwAABD7AAARFAAAES0AABFCAAARWwAAEXAAABGJAAARngAAEbcAABHQAAAR5QAAEf4AABITAAASLAAAEkEAABJaAAASbwAAEogAABKhAAAStgAAEs8AABLkAAAS/QAAExIAABMrAAATXwAAE3QAABONAAATogAAE7sAABPQAAAT6QAAE/4AABQXAAAUMAAAFEUAABReAAAUcwAAFIwAABShAAAUugAAFNMAABToAAAVAQAAFRYAABUvAAAVRAAAFV0AABVyAAAViwAAFb8AABXUAAAV7QAAFgIAABYbAAAWMAAAFkkAABZiAAAWdwAAFpAAABalAAAWvgAAFtMAABbsAAAXAQAAFxoAABczAAAXSAAAF2EAABd2AAAXjwAAF6QAABe9AAAX1gAAF+sAABgfAAAYNAAAGE0AABhiAAAYewAAGJAAABipAAAYwgAAGNcAABjwAAAZBQAAGR4AABkzAAAZTAAAGWUAABl6AAAZkwAAGagAABnBAAAZ1gAAGe8AABoEAAAaHQAAGjYAABpLAAAAGnNncGQBAAAAcm9sbAAAAAIAAAAB//8AAAAcc2JncAAAAAByb2xsAAAAAQAAAJ4AAAABAAAAYnVkdGEAAABabWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAbWRpcmFwcGwAAAAAAAAAAAAAAAAtaWxzdAAAACWpdG9vAAAAHWRhdGEAAAABAAAAAExhdmY2MC4xNi4xMDAAAAAIZnJlZQAACZ9tZGF03gIATGF2YzYwLjMxLjEwMgACMEAOgkmDQgAJ8AWWADgkHBhCAAAwYAAAZz///v1m////kwf//+5WdRUyilzwARggBwEYIAeGAECSnABQwAADYAAAWfmG4AEYIAcBGCAHhgBAkpwATOAAA2AAAFn5huABGCAHhgBAkpwATEAAA2AAAFn5huABGCAHARggB4YAQJKcAEtAAANgAABZ+YbgARggB4YAQJKcAEogAANgAABZ+YbgARggBwEYIAeGAECSnABJAAADYAAAWfmG4AEYIAeGAECSnABIIAADYAAAWfmG4AEYIAcBGCAHhgBAkpwASAAAA2AAAFn5huABGCAHARggB4YAQJKcAEfgAANgAABZ+YbgARggB4YAwJKcAEQgAANgAABZ+YbgARggBwEYIAeGAECSnABHoAADYAAAWfmG4AEYIAeGAECSnABHoAADYAAAWfmG4AEYIAcBGCAHhgBAkpwAR4AAA2AAAFn5huABGCAHhgBAkpwAR4AAA2AAAFn5huABGCAHARggB4YAQJKcAEdgAANgAABZ+YbgARggB4YAQJKcAEdgAANgAABZ+YbgARggBwEYIAeGAMCSnABBYAADYAAAWfmG4AEYIAcBGCAHhgBAkpwAR0AAA2AAAFn5huABGCAHhgBAkpwAR0AAA2AAAFn5huABGCAHARggB4YAQJKcAEdAAANgAABZ+YbgARggB4YAQJKcAEdAAANgAABZ+YbgARggBwEYIAeGAECSnABHQAADYAAAWfmG4AEYIAeGAECSnABHIAADYAAAWfmG4AEYIAcBGCAHhgBAkpwARyAAA2AAAFn5huABGCAHARggB4JJg0IACfAFlgA4JBwYFgAAMGAAAHi5///N0h////caf///F4c/S6P71LiwARggB4YAQJKcAEeAAANgAABZ+YbgARggBwEYIAeGAECSnABHgAADYAAAWfmG4AEYIAeGAECSnABHgAADYAAAWfmG4AEYIAcBGCAHhgBAkpwAR4AAA2AAAFn5huABGCAHhgBAkpwAR2AAA2AAAFn5huABGCAHARggB4YAQJKcAEdgAANgAABZ+YbgARggB4YAQJKcAEdgAANgAABZ+YbgARggBwEYIAeGAECSnABHYAADYAAAWfmG4AEYIAcBGCAHhgBAkpwAR2AAA2AAAFn5huABGCAHhgDAkpwAQWAAA2AAAFn5huABGCAHARggB4YAQJKcAEdgAANgAABZ+YbgARggB4YAQJKcAEdAAANgAABZ+YbgARggBwEYIAeGAECSnABHQAADYAAAWfmG4AEYIAeGAECSnABHQAADYAAAWfmG4AEYIAcBGCAHhgBAkpwAR0AAA2AAAFn5huABGCAHARggB4YAQJKcAEdAAANgAABZ+YbgARggB4YAwJKcAEFgAANgAABZ+YbgARggBwEYIAeGAECSnABHQAADYAAAWfmG4AEYIAeGAECSnABHQAADYAAAWfmG4AEYIAcBGCAHhgBAkpwAR0AAA2AAAFn5huABGCAHhgBAkpwAR0AAA2AAAFn5huABGCAHARggB4YAQJKcAEcgAANgAABZ+YbgARggB4YAQJKcAEcgAANgAABZ+YbgARggBwEYIAeGAECSnABHIAADYAAAWfmG4AEYIAcBGCAHgkmDQgAJ8AWWADgkHBgWAAAwYAAAeLn//83SH///9xp///8Xhz9Lo/vUuLABGCAHhgBAkpwAR2AAA2AAAFn5huABGCAHARggB4YAQJKcAEdgAANgAABZ+YbgARggB4YAQJKcAEdgAANgAABZ+YbgARggBwEYIAeGAECSnABHYAADYAAAWfmG4AEYIAeGAECSnABHQAADYAAAWfmG4AEYIAcBGCAHhgBAkpwAR0AAA2AAAFn5huABGCAHARggB4YAQJKcAEdAAANgAABZ+YbgARggB4YAQJKcAEdAAANgAABZ+YbgARggBwEYIAeGAECSnABHQAADYAAAWfmG4AEYIAeGAMCSnABBYAADYAAAWfmG4AEYIAcBGCAHhgBAkpwAR0AAA2AAAFn5huABGCAHhgBAkpwAR0AAA2AAAFn5huABGCAHARggB4YAQJKcAEdAAANgAABZ+YbgARggB4YAQJKcAEdAAANgAABZ+YbgARggBwEYIAeGAECSnABHQAADYAAAWfmG4AEYIAcBGCAHhgBAkpwAR0AAA2AAAFn5huABGCAHhgDAkpwAQWAAA2AAAFn5huABGCAHARggB4YAQJKcAEdAAANgAABZ+YbgARggB4YAQJKcAEdAAANgAABZ+YbgARggBwEYIAeGAECSnABHQAADYAAAWfmG4AEYIAeGAECSnABHIAADYAAAWfmG4AEYIAcBGCAHhgBAkpwARyAAA2AAAFn5huABGCAHARggB4YAQJKcAEcgAANgAABZ+YbgARggB4YAQJKcAEcgAANgAABZ+YbgARggBwEYIAeCSYNCAAnwBZYAOCQcGBYAADBgAAB4uf//zdIf///3Gn///xeHP0uj+9S4sAEYIAeGAECSnABHQAADYAAAWfmG4AEYIAcBGCAHhgBAkpwAR0AAA2AAAFn5huABGCAHhgBAkpwAR0AAA2AAAFn5huABGCAHARggB4YAQJKcAEdAAANgAABZ+YbgARggB4YAQJKcAEdAAANgAABZ+YbgARggBwEYIAeGAECSnABHQAADYAAAWfmG4AEYIAcBGCAHhgBAkpwAR0AAA2AAAFn5huABGCAHhgBAkpwAR0AAA2AAAFn5huABGCAHARggB4YAQJKcAEdAAANgAABZ+YbgARggB4YAwJKcAEFgAANgAABZ+YbgARggBwEYIAeGAECSnABHQAADYAAAWfmG4AEYIAeGAECSnABHQAADYAAAWfmG4AEYIAcBGCAHhgBAkpwAR0AAA2AAAFn5huABGCAHARggB4YAQJKcAEdAAANgAABZ+YbgARggB4YAQJKcAEdAAANgAABZ+YbgARggBwEYIAeGAECSnABHQAADYAAAWfmG4AEYIAeGAMCSnABBYAADYAAAWfmG4AEYIAcBGCAHhgBAkpwAR0AAA2AAAFn5huABGCAHhgBAkpwAR0AAA2AAAFn5huABGCAHARggB4YAQJKcAEcgAANgAABZ+YbgARggB4YAQJKcAEcgAANgAABZ+YbgARggBwEYIAeGAECSnABHIAADYAAAWfmG4AEYIAcBGCAHhgBAkpwARyAAA2AAAFn5huABGCAHhgBAkpwARyAAA2AAAFn5huABGCAHARggBw=="
)


def prepare(ctx: AppContext, mode: str) -> None:
    if not ctx.e2e:
        raise RuntimeError("e2e seed refused: HORDE_E2E is not set")

    from . import models  # noqa: F401 - register tables
    from .database import init_db

    engine = ctx.engine
    paths = ctx.paths
    paths.data.mkdir(parents=True, exist_ok=True)
    _empty_dir(paths.downloads)
    for extra in (
        paths.thumbnails,
        paths.sprites,
        paths.backgrounds,
        paths.fonts,
        paths.avatars,
        paths.data / "trash",
    ):
        _empty_dir(extra)

    init_db(engine)
    app_mode = mode == "app"
    # Browsers keep their session cookie across resets, so in app mode the seeded
    # accounts (and their sessions) survive; setup mode starts with nobody.
    _clear_tables(engine, keep_accounts=app_mode)

    _write_settings(paths.data, setup_completed=app_mode)
    ctx.download_queue.reset()

    if not app_mode:
        return

    _seed_accounts(engine)
    _seed_library(paths.downloads, engine)
    _seed_live(ctx)


#: A channel the browser suite can follow; the live directory says it is live.
E2E_LIVE_CHANNEL = "https://youtube.com/@hordelive"


def _seed_live(ctx: AppContext) -> None:
    """One live broadcast in the directory (there is no live poller offline)."""
    import time

    from .services.live.directory import ChannelLiveState
    from .services.live.page import LiveBroadcast

    never_stale = time.time() + 10 * 365 * 86400
    ctx.live.directory.retain(set())
    ctx.live.directory.seed(
        [
            ChannelLiveState(
                channel_url=E2E_LIVE_CHANNEL,
                channel_name="Horde Live",
                broadcast=LiveBroadcast(
                    video_id="hordelive01",
                    title="Late night speedruns",
                    channel_name="Horde Live",
                    game="Celeste",
                    viewers=1234,
                    started_at=None,
                ),
                checked_at=never_stale,
                confirmed_at=never_stale,
            )
        ]
    )


#: Accounts every app-mode e2e run starts with: (username, password, admin, grants).
#: ``viewer`` can watch and nothing else, to exercise permission-gated screens.
E2E_ACCOUNTS = (
    ("admin", "e2e-admin-password", True, ()),
    ("member", "e2e-member-password", False, None),  # None = default grants
    ("viewer", "e2e-viewer-password", False, ("use_ai",)),
)
_ACCOUNT_TABLES = {"users", "user_sessions"}


def _clear_tables(engine, *, keep_accounts: bool = False) -> None:
    """Empty every table (children first) but keep the migrated schema."""
    with engine.begin() as conn:
        for table in reversed(SQLModel.metadata.sorted_tables):
            if keep_accounts and table.name in _ACCOUNT_TABLES:
                continue
            conn.execute(table.delete())
        if keep_accounts:
            conn.exec_driver_sql(
                "DELETE FROM sqlite_sequence WHERE name NOT IN ('users', 'user_sessions')"
            )
        else:
            conn.exec_driver_sql("DELETE FROM sqlite_sequence")


def _seed_accounts(engine) -> None:
    """Make the seeded accounts exist with known passwords and roles.

    Accounts a test created are removed (their sessions go with them). Existing
    seeded accounts keep their rows, so a browser that signed in earlier stays
    signed in; their password, role and grants are put back.
    """
    from sqlmodel import Session, select

    from .models import User
    from .services.auth import accounts, passwords, permissions

    seeded = {name for name, *_ in E2E_ACCOUNTS}
    with Session(engine) as session:
        for user in session.exec(select(User)).all():
            if user.username_norm not in seeded:
                session.delete(user)
        session.commit()
        for name, password, is_admin, grants in E2E_ACCOUNTS:
            wanted = permissions.DEFAULT_PERMISSIONS if grants is None else set(grants)
            account = accounts.get_by_username(session, name)
            if account is None:
                accounts.create_user(
                    session, name, password, is_admin=is_admin, granted=wanted
                )
                continue
            if not passwords.verify_password(password, account.password_hash):
                account.password_hash = passwords.hash_password(password)
            account.is_admin = is_admin
            account.disabled = False
            account.permissions = permissions.dump(wanted)
            account.avatar_version = None
            session.add(account)
        session.commit()


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


def _seed_library(downloads: Path, engine: Engine) -> None:
    from sqlmodel import Session

    from .models import (
        DownloadJob,
        JobStatus,
        Playlist,
        PlaylistItem,
        PlaylistSource,
        UserVideoState,
        Video,
        VideoStatus,
        require_id,
    )
    from .services.auth import accounts

    now = datetime.now(UTC).replace(second=0, microsecond=0)
    yesterday = now - timedelta(days=1)
    published = datetime(2024, 5, 14, 12, tzinfo=UTC)
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

        # The admin has watched two videos; nobody else has watched anything.
        admin = accounts.get_by_username(session, "admin")
        if admin is None:
            raise RuntimeError("the seeded admin account is missing")
        session.add(
            UserVideoState(
                user_id=require_id(admin),
                video_id=require_id(aurora),
                position_sec=40,
                last_watched_at=now,
            )
        )
        session.add(
            UserVideoState(
                user_id=require_id(admin),
                video_id=require_id(harbor),
                position_sec=15,
                last_watched_at=yesterday,
            )
        )
        session.commit()

        playlist = Playlist(
            name="Evening set",
            source_type=PlaylistSource.user,
            position=0,
        )
        session.add(playlist)
        session.commit()
        session.refresh(playlist)
        session.add(
            PlaylistItem(
                playlist_id=require_id(playlist),
                video_id=require_id(aurora),
                position=0,
            )
        )
        session.add(
            PlaylistItem(
                playlist_id=require_id(playlist),
                video_id=require_id(harbor),
                position=1,
            )
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


#: Channel of the filler videos ``add_bulk_videos`` creates.
BULK_CHANNEL = "Bulkland"


def add_bulk_videos(engine: Engine, count: int) -> None:
    """Insert ``count`` ready videos in ``BULK_CHANNEL`` (rows only, no media files).

    Every ten videos share one ``added_at`` and one duration, so paging has to
    break ties in the sort key to avoid dropping or repeating a video.
    """
    from sqlmodel import Session

    from .models import Video, VideoStatus

    base = datetime(2023, 1, 1, tzinfo=UTC)
    with Session(engine) as session:
        session.add_all(
            Video(
                title=f"Bulk video {i:04d}",
                channel=BULK_CHANNEL,
                file_path=f"{BULK_CHANNEL}/bulk-{i:04d}.mp4",
                status=VideoStatus.ready,
                duration_sec=float(30 + (i // 10)),
                added_at=base + timedelta(minutes=i // 10),
            )
            for i in range(count)
        )
        session.commit()
