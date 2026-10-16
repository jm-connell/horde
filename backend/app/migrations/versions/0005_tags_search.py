"""Tag table, full-text search index and indexed YouTube id.

* ``video_tags(video_id, tag, source)`` replaces ``LIKE '%"tag"%'`` scans over
  the JSON ``videos.tags`` column. ``videos.tags`` stays the column the
  application writes (it keeps order and spelling and is what the API returns);
  triggers rebuild a video's ``video_tags`` rows whenever ``videos.tags`` or the
  ``ai_tags`` / ``user_tags`` lists in ``video_ai_meta`` change, so no writer can
  forget to keep the two in step. ``source`` is ``user`` when the tag is in
  ``user_tags``, ``ai`` when it is in ``ai_tags``, otherwise ``source``.
* ``videos_fts`` (FTS5: title, description, notes, channel, tags) with triggers,
  rowid = ``videos.id``. Skipped, with a warning, when this SQLite build has no
  FTS5; keyword search then falls back to the REGEXP clause.
* ``videos.youtube_id`` (indexed), backfilled from ``source_url`` and the
  ``[id]`` token in ``file_path``. The application keeps it current with an ORM
  listener.

Triggers belong to the ``videos`` table: a later revision that rebuilds it with
``batch_alter_table`` (drop + rename) loses them and must recreate them.

Revision ID: 0005_tags_search
Revises: 0004_permissions_chat
"""

import logging
import re
from collections.abc import Sequence
from urllib.parse import parse_qs, urlparse

import sqlalchemy as sa
from alembic import op
from sqlalchemy.exc import OperationalError

revision: str = "0005_tags_search"
down_revision: str | None = "0004_permissions_chat"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

logger = logging.getLogger("alembic.runtime.migration")

_YOUTUBE_HOSTS = {
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "music.youtube.com",
    "youtu.be",
}
_PATH_ID_RE = re.compile(r"\[([A-Za-z0-9_-]{11})\]")


def _json_list(expr: str) -> str:
    """json_each source that tolerates malformed or non-list JSON."""
    return (
        f"json_each(CASE WHEN json_valid({expr}) AND json_type({expr}) = 'array' "
        f"THEN {expr} ELSE '[]' END)"
    )


def _tag_rows_select(video_id_filter: str) -> str:
    """SELECT of (video_id, tag, source) for the videos matching the filter."""

    def in_list(column: str) -> str:
        return (
            "EXISTS (SELECT 1 FROM video_ai_meta m, "  # noqa: S608 - SQL assembled from fixed fragments, no user input
            f"{_json_list('m.' + column)} u "
            "WHERE m.video_id = v.id AND u.type = 'text' "
            "AND lower(trim(u.value)) = lower(trim(j.value)))"
        )

    return (
        "SELECT v.id, trim(j.value), "  # noqa: S608 - SQL assembled from fixed fragments, no user input
        f"CASE WHEN {in_list('user_tags')} THEN 'user' "
        f"WHEN {in_list('ai_tags')} THEN 'ai' ELSE 'source' END "
        f"FROM videos v, {_json_list('v.tags')} j "
        f"WHERE {video_id_filter} AND j.type = 'text' AND trim(j.value) <> ''"
    )


def _retag(video_id_expr: str) -> str:
    return (
        f"DELETE FROM video_tags WHERE video_id = {video_id_expr};\n"  # noqa: S608 - SQL assembled from fixed fragments, no user input
        "INSERT OR IGNORE INTO video_tags (video_id, tag, source) "
        f"{_tag_rows_select('v.id = ' + video_id_expr)};"
    )


def _create_tag_triggers() -> None:
    op.execute(
        "CREATE TRIGGER trg_videos_tags_insert AFTER INSERT ON videos BEGIN\n"
        f"{_retag('NEW.id')}\nEND"
    )
    op.execute(
        "CREATE TRIGGER trg_videos_tags_update AFTER UPDATE OF tags ON videos BEGIN\n"
        f"{_retag('NEW.id')}\nEND"
    )
    op.execute(
        "CREATE TRIGGER trg_ai_meta_tags_insert AFTER INSERT ON video_ai_meta BEGIN\n"
        f"{_retag('NEW.video_id')}\nEND"
    )
    op.execute(
        "CREATE TRIGGER trg_ai_meta_tags_update "
        "AFTER UPDATE OF ai_tags, user_tags ON video_ai_meta BEGIN\n"
        f"{_retag('NEW.video_id')}\nEND"
    )


def _fts_tag_text(row: str) -> str:
    return f"(SELECT group_concat(value, ' ') FROM {_json_list(row + '.tags')})"  # noqa: S608 - SQL assembled from fixed fragments, no user input


def _fts_row(row: str) -> str:
    return (
        f"{row}.id, {row}.title, {row}.description, {row}.notes, {row}.channel, "
        f"{_fts_tag_text(row)}"
    )


_FTS_COLUMNS = "rowid, title, description, notes, channel, tags"


def _create_fts() -> bool:
    try:
        op.execute(
            "CREATE VIRTUAL TABLE videos_fts USING fts5("
            "title, description, notes, channel, tags, tokenize = 'unicode61')"
        )
    except OperationalError as exc:
        if "fts5" not in str(exc).lower():
            raise
        logger.warning(
            "SQLite has no FTS5 module; keyword search will use the REGEXP fallback"
        )
        return False
    op.execute(
        f"INSERT INTO videos_fts ({_FTS_COLUMNS}) SELECT {_fts_row('videos')} FROM videos"  # noqa: S608 - SQL assembled from fixed fragments, no user input
    )
    op.execute(
        "CREATE TRIGGER trg_videos_fts_insert AFTER INSERT ON videos BEGIN\n"
        f"INSERT INTO videos_fts ({_FTS_COLUMNS}) SELECT {_fts_row('NEW')};\nEND"
    )
    op.execute(
        "CREATE TRIGGER trg_videos_fts_update "
        "AFTER UPDATE OF title, description, notes, channel, tags ON videos BEGIN\n"
        "DELETE FROM videos_fts WHERE rowid = OLD.id;\n"
        f"INSERT INTO videos_fts ({_FTS_COLUMNS}) SELECT {_fts_row('NEW')};\nEND"
    )
    op.execute(
        "CREATE TRIGGER trg_videos_fts_delete AFTER DELETE ON videos BEGIN\n"
        "DELETE FROM videos_fts WHERE rowid = OLD.id;\nEND"
    )
    return True


def _youtube_id(source_url: str | None, file_path: str | None) -> str | None:
    """Frozen copy of the runtime derivation (see services/youtube_id.py)."""
    if source_url:
        try:
            parsed = urlparse(source_url.strip())
        except ValueError:
            parsed = None
        if parsed is not None and parsed.netloc.lower() in _YOUTUBE_HOSTS:
            found = None
            if parsed.netloc.lower() == "youtu.be":
                found = parsed.path.lstrip("/").split("/")[0] or None
            elif parsed.path == "/watch":
                values = parse_qs(parsed.query).get("v")
                found = values[0] if values else None
            else:
                for prefix in ("/shorts/", "/embed/", "/live/", "/v/"):
                    if parsed.path.startswith(prefix):
                        found = parsed.path[len(prefix) :].split("/")[0] or None
                        break
            if found:
                return found
    if file_path:
        match = _PATH_ID_RE.search(file_path)
        if match:
            return match.group(1)
    return None


def upgrade() -> None:
    op.add_column("videos", sa.Column("youtube_id", sa.String(), nullable=True))
    bind = op.get_bind()
    updates = []
    for video_id, source_url, file_path in bind.execute(
        sa.text("SELECT id, source_url, file_path FROM videos")
    ):
        yt_id = _youtube_id(source_url, file_path)
        if yt_id:
            updates.append({"id": video_id, "yt": yt_id})
    if updates:
        bind.execute(
            sa.text("UPDATE videos SET youtube_id = :yt WHERE id = :id"), updates
        )
    op.create_index("ix_videos_youtube_id", "videos", ["youtube_id"])

    op.create_table(
        "video_tags",
        sa.Column("video_id", sa.Integer(), nullable=False),
        sa.Column("tag", sa.String(collation="NOCASE"), nullable=False),
        sa.Column("source", sa.String(), nullable=False),
        sa.ForeignKeyConstraint(["video_id"], ["videos.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("video_id", "tag", "source"),
    )
    op.create_index("ix_video_tags_tag", "video_tags", ["tag"])
    op.execute(
        "INSERT OR IGNORE INTO video_tags (video_id, tag, source) "
        f"{_tag_rows_select('1 = 1')}"
    )
    _create_tag_triggers()
    _create_fts()


def downgrade() -> None:
    raise NotImplementedError(
        "Horde migrations are forward-only. To go back, restore horde.db from "
        "a backup taken before the upgrade (see docs/design/sqlite-and-migrations.md)."
    )
