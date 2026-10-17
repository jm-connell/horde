"""Alembic-based schema management: fresh installs, legacy adoption, integrity."""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest
from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from sqlalchemy import inspect, text
from sqlmodel import Session, SQLModel, select

from app.migrations.runner import CONTEXT_OPTIONS, SchemaTooNewError

HEAD = "0008_stream_ai"
LEGACY_SQL = Path(__file__).parent / "fixtures" / "pre_alembic_schema.sql"


def _revision(engine) -> str | None:
    with engine.connect() as conn:
        return MigrationContext.configure(conn).get_current_revision()


def _index_names(engine) -> set[str]:
    with engine.connect() as conn:
        rows = conn.execute(
            text(
                "SELECT name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL"
            )
        ).fetchall()
    return {row[0] for row in rows}


def _make_legacy_db(db_path: Path) -> None:
    """A database as the last pre-Alembic release left it, with old-style rows."""
    con = sqlite3.connect(db_path)
    try:
        con.executescript(LEGACY_SQL.read_text())
        con.executescript(
            """
            INSERT INTO videos (id, title, tags, subtitles, file_path, added_at,
                last_position_sec, needs_review, status, subtitles_pending,
                subtitles_fetch_attempts, source_chapters, is_hdr,
                title_is_custom, description_is_custom)
            VALUES
              (1, 'One', '["a"]', '[]', 'c/one.mp4', '2024-01-01 00:00:00', 0, 0,
               'ready', 0, 0, '[]', 0, 0, 0),
              (2, 'Two', '[]', '[]', 'c/two.mp4', '2024-01-02 00:00:00', 12.5, 0,
               'ready', 0, 0, '[]', 0, 0, 0),
              (7, 'Seven', '[]', '[]', 'c/seven.mp4', '2024-01-03 00:00:00', 0, 0,
               'ready', 0, 0, '[]', 0, 0, 0);
            INSERT INTO playlists (id, name, source_type, subscribed, position,
                created_at, cover_video_id)
            VALUES (1, 'Mix', 'user', 0, 0, '2024-01-01 00:00:00', 1),
                   (2, 'Gone cover', 'user', 0, 1, '2024-01-02 00:00:00', 99);
            INSERT INTO playlist_items (id, playlist_id, video_id, position)
            VALUES (1, 1, 1, 5), (2, 1, 1, 2), (3, 1, 2, 3),
                   (4, 1, 99, 4), (5, 77, 1, 0);
            INSERT INTO video_embeddings (id, video_id, chunk_index, model, dim,
                vector, content_hash, updated_at)
            VALUES (1, 1, -1, 'm', 1, x'00', 'h', '2024-01-01 00:00:00'),
                   (2, 99, -1, 'm', 1, x'00', 'h', '2024-01-01 00:00:00');
            INSERT INTO video_ai_meta (video_id, embed_status, content_hash,
                ai_tags, user_tags, tags_locked, updated_at)
            VALUES (1, 'done', 'h', '[]', '["mine"]', 0, '2024-01-01 00:00:00'),
                   (99, 'done', 'h', '[]', '[]', 0, '2024-01-01 00:00:00');
            INSERT INTO download_jobs (id, url, quality_preset, status, progress,
                paused, normalize_volume, video_codec, destination, video_id,
                replace_video_id, created_at)
            VALUES (1, 'u1', 'best', 'completed', 100, 0, 0, 'av1', 'library', 1,
                    NULL, '2024-01-01 00:00:00'),
                   (2, 'u2', 'best', 'completed', 100, 0, 0, 'av1', 'library', 99,
                    98, '2024-01-01 00:00:00');
            INSERT INTO openrouter_usage (id, kind, cost, video_id, created_at)
            VALUES (1, 'summary', 0.5, 99, '2024-01-01 00:00:00');
            INSERT INTO ai_jobs (id, kind, video_id, status, attempts, created_at,
                updated_at)
            VALUES (1, 'embed_video', 1, 'queued', 0, '2024-01-01 00:00:00',
                    '2024-01-01 00:00:00'),
                   (2, 'embed_video', 99, 'queued', 0, '2024-01-01 00:00:00',
                    '2024-01-01 00:00:00');
            """
        )
        con.commit()
    finally:
        con.close()


def test_fresh_database_matches_models(tmp_dirs):
    """`upgrade head` on an empty DB must equal the models: drift fails CI."""
    from app.database import init_db

    engine = tmp_dirs["engine"]
    init_db()
    assert _revision(engine) == HEAD
    with engine.connect() as conn:
        mc = MigrationContext.configure(conn, opts=CONTEXT_OPTIONS)
        diffs = compare_metadata(mc, SQLModel.metadata)
    assert diffs == [], (
        "models.py and the Alembic revisions disagree. Generate a revision with "
        "`cd backend && alembic revision --autogenerate -m ...`:\n"
        f"{diffs}"
    )


def test_init_db_is_idempotent(tmp_dirs):
    from app.database import init_db

    init_db()
    init_db()
    assert _revision(tmp_dirs["engine"]) == HEAD
    # No backup is taken when nothing is pending.
    assert not list((tmp_dirs["data"] / "backups").glob("*"))


def test_legacy_install_is_adopted_and_data_preserved(tmp_dirs):
    from app.database import init_db
    from app.models import DownloadJob, Video

    engine = tmp_dirs["engine"]
    _make_legacy_db(tmp_dirs["db_path"])
    assert "alembic_version" not in inspect(engine).get_table_names()

    init_db()

    assert _revision(engine) == HEAD
    with Session(engine) as session:
        assert {v.id: v.title for v in session.exec(select(Video)).all()} == {
            1: "One",
            2: "Two",
            7: "Seven",
        }
        two = session.get(Video, 2)
        assert two.last_position_sec == 12.5
        assert session.get(Video, 1).tags == '["a"]'
        # Soft pointers to missing rows were cleared, history rows kept.
        job1, job2 = session.get(DownloadJob, 1), session.get(DownloadJob, 2)
        assert job1.video_id == 1
        assert job2.video_id is None and job2.replace_video_id is None
    with engine.connect() as conn:
        # Orphans were removed; the duplicate (1, 1) item kept the lowest position.
        assert conn.execute(
            text(
                "SELECT id, playlist_id, video_id, position FROM playlist_items ORDER BY id"
            )
        ).fetchall() == [(2, 1, 1, 2), (3, 1, 2, 3)]
        assert conn.execute(text("SELECT id FROM video_embeddings")).fetchall() == [
            (1,)
        ]
        assert conn.execute(text("SELECT video_id FROM video_ai_meta")).fetchall() == [
            (1,)
        ]
        assert conn.execute(text("SELECT id FROM ai_jobs")).fetchall() == [(1,)]
        assert conn.execute(
            text("SELECT id, cover_video_id FROM playlists ORDER BY id")
        ).fetchall() == [(1, 1), (2, None)]
        assert conn.execute(
            text("SELECT id, video_id FROM openrouter_usage")
        ).fetchall() == [(1, None)]
        assert conn.execute(text("PRAGMA foreign_key_check")).fetchall() == []
        ledger = conn.execute(text("SELECT id FROM schema_migrations")).fetchall()
    assert ("2026_09_playlist_positions",) in ledger
    # A pre-migration copy was written for rollback.
    backups = list((tmp_dirs["data"] / "backups").glob("horde-pre-*.db"))
    assert len(backups) == 1
    old = sqlite3.connect(backups[0])
    try:
        assert old.execute("SELECT count(*) FROM videos").fetchone() == (3,)
        assert old.execute("SELECT count(*) FROM playlist_items").fetchone() == (5,)
    finally:
        old.close()


def test_legacy_and_fresh_databases_converge(tmp_dirs, tmp_path):
    """Upgraded installs get every index a fresh install has, and vice versa."""
    from app.database import create_sqlite_engine, init_db

    fresh = create_sqlite_engine(f"sqlite:///{tmp_path / 'fresh.db'}")
    init_db(fresh)

    _make_legacy_db(tmp_dirs["db_path"])
    init_db()

    assert _index_names(tmp_dirs["engine"]) == _index_names(fresh)
    for table in inspect(fresh).get_table_names():
        assert {
            (
                tuple(fk["constrained_columns"]),
                fk["referred_table"],
                fk["options"].get("ondelete"),
            )
            for fk in inspect(tmp_dirs["engine"]).get_foreign_keys(table)
        } == {
            (
                tuple(fk["constrained_columns"]),
                fk["referred_table"],
                fk["options"].get("ondelete"),
            )
            for fk in inspect(fresh).get_foreign_keys(table)
        }, table
    fresh.dispose()


def test_very_old_install_gets_missing_columns(tmp_dirs):
    """The additive legacy migrator still runs for databases from long ago."""
    from app import legacy_migrations
    from app.database import init_db

    engine = tmp_dirs["engine"]
    _make_legacy_db(tmp_dirs["db_path"])
    con = sqlite3.connect(tmp_dirs["db_path"])
    try:
        # Turn the last pre-Alembic schema into an early one by removing every
        # column the additive migrator is responsible for.
        for table, columns in (
            ("videos", legacy_migrations._VIDEO_COLUMNS),
            ("playlists", legacy_migrations._PLAYLIST_COLUMNS),
        ):
            for name, _ in columns:
                for _, index, *_rest in con.execute(
                    f"PRAGMA index_list({table})"
                ).fetchall():
                    cols = [
                        r[2]
                        for r in con.execute(f"PRAGMA index_info({index})").fetchall()
                    ]
                    if name in cols:
                        con.execute(f"DROP INDEX {index}")
                con.execute(f"ALTER TABLE {table} DROP COLUMN {name}")
        con.commit()
    finally:
        con.close()
    assert "vcodec" not in {c["name"] for c in inspect(engine).get_columns("videos")}

    init_db()

    cols = {c["name"] for c in inspect(engine).get_columns("videos")}
    assert {"notes", "channel_url", "subtitles_retry_after", "vcodec"} <= cols
    with engine.connect() as conn:
        assert conn.execute(
            text("SELECT id, title FROM videos ORDER BY id")
        ).fetchall() == [
            (1, "One"),
            (2, "Two"),
            (7, "Seven"),
        ]
        # Playlist order was backfilled by the legacy ledger step.
        assert sorted(
            conn.execute(text("SELECT position FROM playlists")).scalars().all()
        ) == [0, 1]
    assert _revision(engine) == HEAD


def test_newer_schema_refuses_to_start(tmp_dirs):
    from app.database import init_db

    init_db()
    with tmp_dirs["engine"].begin() as conn:
        conn.execute(
            text("UPDATE alembic_version SET version_num='9999_from_the_future'")
        )
    with pytest.raises(SchemaTooNewError) as err:
        init_db()
    message = str(err.value)
    assert "9999_from_the_future" in message
    assert "update.sh --rollback" in message
    assert "backup" in message.lower()


def test_failed_migration_leaves_database_untouched(tmp_dirs, monkeypatch):
    """Revisions run in one transaction: a failure must not half-rebuild tables."""
    from alembic.operations import Operations

    from app.database import init_db

    engine = tmp_dirs["engine"]
    _make_legacy_db(tmp_dirs["db_path"])

    def boom(self, *args, **kwargs):
        raise RuntimeError("boom")

    # Fail in the last step of 0002, after every table was rebuilt.
    with monkeypatch.context() as patch:
        patch.setattr(Operations, "create_index", boom)
        with pytest.raises(RuntimeError, match="boom"):
            init_db()

    tables = set(inspect(engine).get_table_names())
    assert "alembic_version" not in tables
    assert not [t for t in tables if t.startswith("_alembic_tmp")]
    with engine.connect() as conn:
        videos_sql = conn.execute(
            text("SELECT sql FROM sqlite_master WHERE name = 'videos'")
        ).scalar()
        assert "AUTOINCREMENT" not in videos_sql
        assert conn.execute(text("SELECT count(*) FROM videos")).scalar() == 3
        assert conn.execute(text("SELECT count(*) FROM playlist_items")).scalar() == 5
        # Foreign keys are switched back on for the pooled connection.
        assert conn.execute(text("PRAGMA foreign_keys")).scalar() == 1

    # The database is still migratable afterwards.
    init_db()
    assert _revision(engine) == HEAD


def test_deleted_ids_are_never_reused_and_children_cascade(init_db):
    from app.models import (
        AiJob,
        AiJobKind,
        Playlist,
        PlaylistItem,
        Video,
        VideoAiMeta,
        VideoEmbedding,
    )

    engine = init_db["engine"]
    with Session(engine) as session:
        keep = Video(title="keep", file_path="k.mp4")
        doomed = Video(title="doomed", file_path="d.mp4")
        session.add_all([keep, doomed])
        session.commit()
        playlist = Playlist(name="p")
        session.add(playlist)
        session.commit()
        doomed_id = doomed.id
        assert doomed_id == max(keep.id, doomed.id)
        session.add_all(
            [
                PlaylistItem(playlist_id=playlist.id, video_id=doomed_id),
                VideoEmbedding(video_id=doomed_id, vector=b"x"),
                VideoAiMeta(video_id=doomed_id),
                AiJob(kind=AiJobKind.embed_video, video_id=doomed_id),
            ]
        )
        session.commit()

        # Raw DELETE: only the database FKs can remove the children.
        session.execute(text("DELETE FROM videos WHERE id = :id"), {"id": doomed_id})
        session.commit()
        for table in ("playlist_items", "video_embeddings", "video_ai_meta", "ai_jobs"):
            count = session.execute(text(f"SELECT count(*) FROM {table}")).scalar()  # noqa: S608
            assert count == 0, table

        replacement = Video(title="new", file_path="n.mp4")
        session.add(replacement)
        session.commit()
        assert replacement.id > doomed_id


def test_foreign_keys_are_enforced(init_db):
    from sqlalchemy.exc import IntegrityError

    from app.models import PlaylistItem

    with Session(init_db["engine"]) as session:
        session.add(PlaylistItem(playlist_id=123, video_id=456))
        with pytest.raises(IntegrityError):
            session.commit()


def test_playlist_item_pair_is_unique(init_db):
    from sqlalchemy.exc import IntegrityError

    from app.models import Playlist, PlaylistItem, Video

    with Session(init_db["engine"]) as session:
        video = Video(title="v", file_path="v.mp4")
        playlist = Playlist(name="p")
        session.add_all([video, playlist])
        session.commit()
        session.add(PlaylistItem(playlist_id=playlist.id, video_id=video.id))
        session.commit()
        session.add(PlaylistItem(playlist_id=playlist.id, video_id=video.id))
        with pytest.raises(IntegrityError):
            session.commit()


def test_engine_enables_wal(init_db):
    from app.context import get_engine as _engine

    engine = _engine()

    with engine.connect() as conn:
        mode = conn.execute(text("PRAGMA journal_mode")).scalar()
    assert str(mode).lower() == "wal"


def test_engine_enables_foreign_keys(init_db):
    from app.context import get_engine as _engine

    engine = _engine()

    with engine.connect() as conn:
        assert conn.execute(text("PRAGMA foreign_keys")).scalar() == 1


def test_engine_registers_regexp(init_db):
    from app.context import get_engine as _engine

    engine = _engine()

    with engine.connect() as conn:
        hit = conn.execute(
            text("SELECT 'a used car' REGEXP '(?i)(?<![a-z0-9])car(?![a-z0-9])'")
        ).scalar()
        miss = conn.execute(
            text("SELECT 'graphics card' REGEXP '(?i)(?<![a-z0-9])car(?![a-z0-9])'")
        ).scalar()
    assert hit == 1
    assert miss == 0


def test_adopting_a_table_with_missing_columns_fails_clearly(tmp_dirs):
    from app.database import init_db

    with tmp_dirs["engine"].begin() as conn:
        conn.execute(
            text("CREATE TABLE videos (id INTEGER PRIMARY KEY, title VARCHAR)")
        )
        conn.execute(
            text("CREATE TABLE schema_migrations (id VARCHAR, applied_at VARCHAR)")
        )
        for step in ("2026_07_additive_columns", "2026_09_playlist_positions"):
            conn.execute(
                text("INSERT INTO schema_migrations VALUES (:s, 'x')"), {"s": step}
            )
    with pytest.raises(RuntimeError, match=r"'videos'.*file_path"):
        init_db()


def _insert_video(conn, vid, title, tags, file_path, source_url=None, **extra):
    cols = {
        "id": vid,
        "title": title,
        "tags": tags,
        "file_path": file_path,
        "source_url": source_url,
        "subtitles": "[]",
        "added_at": "2024-01-01 00:00:00",
        "last_position_sec": 0,
        "needs_review": 0,
        "status": "ready",
        "subtitles_pending": 0,
        "subtitles_fetch_attempts": 0,
        "source_chapters": "[]",
        "is_hdr": 0,
        "title_is_custom": 0,
        "description_is_custom": 0,
        **extra,
    }
    conn.execute(
        text(
            f"INSERT INTO videos ({', '.join(cols)}) "  # noqa: S608 - column names are the fixed dict keys above
            f"VALUES ({', '.join(':' + c for c in cols)})"
        ),
        cols,
    )


def test_tags_search_revision_backfills_a_populated_database(tmp_dirs):
    """0004 -> 0005 on a database that already holds videos, tags and AI metadata."""
    from alembic import command

    from app.database import init_db
    from app.migrations.runner import alembic_config

    engine = tmp_dirs["engine"]
    command.upgrade(alembic_config(engine), "0004_permissions_chat")
    assert _revision(engine) == "0004_permissions_chat"
    with engine.begin() as conn:
        _insert_video(
            conn,
            1,
            "Cats at the harbour",
            '["Cats", "harbour", "funny"]',
            "Pets/Cats [dQw4w9WgXcQ].mp4",
            "https://www.youtube.com/watch?v=aaaaaaaaaaa",
            description="Quiet morning",
            notes="Saved for Sam",
            channel="Pets",
        )
        _insert_video(conn, 2, "Broken tags", "not json", "x/two.mp4")
        _insert_video(conn, 3, "Object tags", '{"a": 1}', "x/three.mp4")
        _insert_video(
            conn,
            4,
            "Short link",
            '["Cats"]',
            "x/four.mp4",
            "https://youtu.be/bbbbbbbbbbb",
        )
        _insert_video(
            conn,
            5,
            "Other site",
            "[]",
            "x/five.mp4",
            "https://example.com/watch?v=ccccccccccc",
        )
        conn.execute(
            text(
                "INSERT INTO video_ai_meta (video_id, embed_status, content_hash, "
                "ai_tags, user_tags, tags_locked, updated_at) VALUES "
                "(1, 'ready', 'h', '[\"funny\"]', '[\"CATS\"]', 0, '2024-01-01 00:00:00')"
            )
        )

    init_db()

    assert _revision(engine) == HEAD
    with engine.connect() as conn:
        tags = conn.execute(
            text("SELECT video_id, tag, source FROM video_tags ORDER BY video_id, tag")
        ).fetchall()
        # Source is decided per tag; malformed or non-list JSON yields no rows.
        assert tags == [
            (1, "Cats", "user"),
            (1, "funny", "ai"),
            (1, "harbour", "source"),
            (4, "Cats", "source"),
        ]
        assert dict(
            conn.execute(text("SELECT id, youtube_id FROM videos")).fetchall()
        ) == {
            1: "aaaaaaaaaaa",
            2: None,
            3: None,
            4: "bbbbbbbbbbb",
            5: None,
        }
        fts = conn.execute(
            text(
                "SELECT rowid FROM videos_fts WHERE videos_fts MATCH 'harbour' "
                "ORDER BY rowid"
            )
        ).fetchall()
        assert fts == [(1,)]
        # Notes, channel and tags are indexed too.
        for word, expected in (("sam", 1), ("pets", 1), ("funny", 1), ("broken", 2)):
            assert conn.execute(
                text("SELECT rowid FROM videos_fts WHERE videos_fts MATCH :w"),
                {"w": word},
            ).fetchall() == [(expected,)]
        assert conn.execute(text("PRAGMA foreign_key_check")).fetchall() == []


def test_tag_and_search_triggers_follow_every_writer(session, add_video):
    """Plain UPDATE/DELETE statements keep video_tags and videos_fts in step."""
    video = add_video(title="Original title", tags=["alpha"])

    def rows(sql, **params):
        return session.connection().execute(text(sql), params).fetchall()

    assert rows("SELECT tag, source FROM video_tags") == [("alpha", "source")]

    session.connection().execute(
        text("UPDATE videos SET tags = :t, title = 'Renamed clip' WHERE id = :i"),
        {"t": '["beta", "Gamma"]', "i": video.id},
    )
    assert rows("SELECT tag FROM video_tags ORDER BY tag") == [("beta",), ("Gamma",)]
    assert rows("SELECT rowid FROM videos_fts WHERE videos_fts MATCH 'renamed'") == [
        (video.id,)
    ]
    assert rows("SELECT rowid FROM videos_fts WHERE videos_fts MATCH 'original'") == []
    assert rows("SELECT rowid FROM videos_fts WHERE videos_fts MATCH 'gamma'") == [
        (video.id,)
    ]

    # AI metadata arriving later reclassifies the tag's source.
    session.connection().execute(
        text(
            "INSERT INTO video_ai_meta (video_id, embed_status, content_hash, ai_tags,"
            " user_tags, tags_locked, updated_at) VALUES (:i, 'p', '', '[\"beta\"]',"
            " '[\"gamma\"]', 0, '2024-01-01')"
        ),
        {"i": video.id},
    )
    assert rows("SELECT tag, source FROM video_tags ORDER BY tag") == [
        ("beta", "ai"),
        ("Gamma", "user"),
    ]

    session.connection().execute(
        text("DELETE FROM videos WHERE id = :i"), {"i": video.id}
    )
    assert rows("SELECT count(*) FROM video_tags") == [(0,)]
    assert rows("SELECT count(*) FROM videos_fts") == [(0,)]


EXPECTED_TRIGGERS = {
    "trg_videos_tags_insert",
    "trg_videos_tags_update",
    "trg_videos_tags_delete",
    "trg_ai_meta_tags_insert",
    "trg_ai_meta_tags_update",
    "trg_ai_meta_tags_delete",
    "trg_videos_fts_insert",
    "trg_videos_fts_update",
    "trg_videos_fts_delete",
}


def test_derived_data_triggers_exist_at_head(init_db):
    """SQLite drops a table's triggers when batch_alter_table rebuilds the table."""
    with init_db["engine"].connect() as conn:
        found = {
            row[0]
            for row in conn.execute(
                text("SELECT name FROM sqlite_master WHERE type = 'trigger'")
            )
        }
    assert found == EXPECTED_TRIGGERS, (
        "The set of triggers changed. Any migration that rebuilds `videos` or "
        "`video_ai_meta` (batch_alter_table drops and renames the table) must "
        "recreate the video_tags and videos_fts triggers and refill videos_fts, "
        "or tags and search silently go stale. See docs/design/sqlite-and-migrations.md."
    )


def test_rollback_writes_are_repaired_on_the_next_start(init_db):
    """The pre-overhaul code ran on a migrated database, then Horde was upgraded again.

    That code never turns on ``PRAGMA foreign_keys``, so deleting a video leaves its
    children behind, and its ``create_all`` recreates the dropped ``video_ai_chat``
    table. The next start (already at head) must clean both up.
    """
    from app.database import init_db as run_init_db
    from app.models import DownloadJob, Playlist, PlaylistItem, Video, VideoAiMeta
    from app.services import library

    engine = init_db["engine"]
    with Session(engine) as session:
        doomed = Video(title="doomed", file_path="d.mp4", tags='["phantom"]')
        keep = Video(title="keep", file_path="k.mp4", tags='["kept"]')
        session.add_all([doomed, keep])
        session.commit()
        playlist = Playlist(name="p", cover_video_id=doomed.id)
        session.add(playlist)
        session.commit()
        session.add_all(
            [
                PlaylistItem(playlist_id=playlist.id, video_id=doomed.id, position=0),
                PlaylistItem(playlist_id=playlist.id, video_id=keep.id, position=1),
                VideoAiMeta(video_id=doomed.id, embed_status="done"),
                DownloadJob(url="u", video_id=doomed.id),
            ]
        )
        session.commit()
        doomed_id, keep_id, playlist_id = doomed.id, keep.id, playlist.id

    # What the old code does, on a plain connection (foreign keys off).
    con = sqlite3.connect(init_db["db_path"])
    try:
        con.execute(
            "CREATE TABLE video_ai_chat (id INTEGER PRIMARY KEY, video_id INTEGER "
            "NOT NULL REFERENCES videos (id), updated_at DATETIME)"
        )
        con.execute("INSERT INTO video_ai_chat (video_id) VALUES (?)", (doomed_id,))
        con.execute("DELETE FROM videos WHERE id = ?", (doomed_id,))
        con.commit()
        # The trigger keeps the derived tag table right even without the pragma.
        assert con.execute(
            "SELECT count(*) FROM video_tags WHERE video_id = ?", (doomed_id,)
        ).fetchone() == (0,)
        assert con.execute("PRAGMA foreign_key_check").fetchall() != []
    finally:
        con.close()

    run_init_db()

    with engine.connect() as conn:
        assert conn.execute(text("PRAGMA foreign_key_check")).fetchall() == []
        assert "video_ai_chat" not in inspect(conn).get_table_names()
    with Session(engine) as session:
        assert library.all_tags(session) == ["kept"]
        assert session.get(Playlist, playlist_id).cover_video_id is None
        assert [i.video_id for i in session.exec(select(PlaylistItem)).all()] == [
            keep_id
        ]
        assert session.get(VideoAiMeta, doomed_id) is None
        assert session.exec(select(DownloadJob)).one().video_id is None


_ROLLBACK_DAMAGE = {
    "orphan": (
        "INSERT INTO playlists (name, source_type, subscribed, position, created_at, "
        "cover_video_id) VALUES ('p', 'user', 0, 0, '2024-01-01 00:00:00', 42)"
    ),
    "legacy_table": (
        "CREATE TABLE video_ai_chat (id INTEGER PRIMARY KEY, video_id INTEGER)"
    ),
}


def _repair_backups(data: Path) -> list[Path]:
    return sorted((data / "backups").glob("horde-pre-integrity-repair-*.db"))


@pytest.mark.parametrize("damage", sorted(_ROLLBACK_DAMAGE))
def test_an_integrity_repair_backs_up_the_database_first(init_db, damage):
    """At head no migration backs up, so the repair must before it deletes or drops."""
    from app.database import init_db as run_init_db

    con = sqlite3.connect(init_db["db_path"])
    try:
        con.execute(_ROLLBACK_DAMAGE[damage])
        con.commit()
    finally:
        con.close()

    run_init_db()

    backups = _repair_backups(init_db["data"])
    assert len(backups) == 1
    old = sqlite3.connect(backups[0])
    try:
        # The copy is from before the repair.
        if damage == "orphan":
            assert old.execute("SELECT cover_video_id FROM playlists").fetchall() == [
                (42,)
            ]
        else:
            assert old.execute(
                "SELECT name FROM sqlite_master WHERE name = 'video_ai_chat'"
            ).fetchall() == [("video_ai_chat",)]
    finally:
        old.close()

    # The next start finds nothing to repair and writes no further copy.
    run_init_db()
    assert _repair_backups(init_db["data"]) == backups


def test_a_clean_start_at_head_writes_no_backup(init_db):
    from app.database import init_db as run_init_db

    run_init_db()

    assert list((init_db["data"] / "backups").glob("horde-pre-*.db")) == []


def test_migration_backups_are_pruned_by_age_whatever_their_label(init_db):
    from app.migrations.runner import BACKUP_KEEP, _backup_database

    folder = init_db["data"] / "backups"
    folder.mkdir()
    oldest = folder / "horde-pre-integrity-repair-20200101T000000Z.db"
    oldest.write_bytes(b"old")
    revisions = [
        folder / f"horde-pre-0005-to-0006-2020020{i}T000000Z.db"
        for i in range(1, BACKUP_KEEP + 1)
    ]
    for path in revisions:
        path.write_bytes(b"rev")

    newest = _backup_database(init_db["engine"], "0006-to-0007")

    kept = sorted(folder.glob("horde-pre-*.db"))
    assert newest in kept and len(kept) == BACKUP_KEEP
    assert not oldest.exists() and not revisions[0].exists()


def test_all_tags_ignores_tags_of_missing_videos(session, add_video):
    """A stray video_tags row (written with foreign keys off) is not a library tag."""
    add_video(tags=["real"])
    raw = session.connection().connection.driver_connection
    raw.execute("PRAGMA foreign_keys=OFF")
    try:
        raw.execute(
            "INSERT INTO video_tags (video_id, tag, source) VALUES (999, 'ghost', 'source')"
        )
    finally:
        raw.execute("PRAGMA foreign_keys=ON")
    from app.services import library

    assert library.all_tags(session) == ["real"]


def test_orphans_do_not_block_a_pending_migration(init_db):
    """A database behind head with orphans (foreign keys were off) still upgrades."""
    from app.database import init_db as run_init_db

    engine = init_db["engine"]
    con = sqlite3.connect(init_db["db_path"])
    try:
        con.executescript(
            """
            DROP TRIGGER trg_videos_tags_delete;
            DROP TABLE channel_follows;
            DROP TABLE download_requesters;
            DROP TABLE stream_ai_chat_messages;
            DROP TABLE stream_ai_state;
            UPDATE alembic_version SET version_num = '0005_tags_search';
            INSERT INTO playlists (name, source_type, subscribed, position,
                created_at, cover_video_id)
            VALUES ('p', 'user', 0, 0, '2024-01-01 00:00:00', 42);
            INSERT INTO video_tags (video_id, tag, source) VALUES (42, 'ghost', 'source');
            """
        )
        con.commit()
    finally:
        con.close()

    run_init_db()

    assert _revision(engine) == HEAD
    with engine.connect() as conn:
        assert conn.execute(text("PRAGMA foreign_key_check")).fetchall() == []
        assert conn.execute(text("SELECT cover_video_id FROM playlists")).all() == [
            (None,)
        ]


def test_a_violation_the_repair_cannot_fix_does_not_rotate_the_backups(init_db):
    """A NO ACTION orphan survives every repair; it must not back up on each start."""
    from app.database import init_db as run_init_db
    from app.migrations.runner import BACKUP_KEEP

    folder = init_db["data"] / "backups"
    folder.mkdir()
    real = [
        folder / f"horde-pre-0005-to-0006-2020020{i}T000000Z.db"
        for i in range(1, BACKUP_KEEP + 1)
    ]
    for path in real:
        path.write_bytes(b"rev")
    con = sqlite3.connect(init_db["db_path"])
    try:
        con.execute(
            "CREATE TABLE no_action_child (id INTEGER PRIMARY KEY, video_id INTEGER "
            "REFERENCES videos (id))"
        )
        con.execute("INSERT INTO no_action_child (video_id) VALUES (999)")
        con.commit()
    finally:
        con.close()

    for _ in range(6):
        run_init_db()

    assert all(path.exists() for path in real)
    assert _repair_backups(init_db["data"]) == []
