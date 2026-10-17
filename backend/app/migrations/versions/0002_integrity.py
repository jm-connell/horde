"""Referential integrity, AUTOINCREMENT ids and the missing indexes.

* Declares ``ON DELETE`` behaviour on every foreign key (see models.py for the
  CASCADE / SET NULL rationale) and adds the FKs the old schema never had.
* Makes the ids that other tables reference AUTOINCREMENT, so a deleted id is
  never handed to an unrelated row.
* Adds ``UNIQUE (playlist_id, video_id)`` on playlist items.
* Creates every index the models declare. Installs upgraded from the
  pre-Alembic schema never got indexes for columns added later, so fresh and
  upgraded databases differed; ``IF NOT EXISTS`` makes them converge.

Existing rows that would violate the new constraints are repaired first:
orphaned children are deleted, dangling soft pointers are set to NULL and
duplicate playlist items are collapsed (lowest position wins). Counts are
logged.

Revision ID: 0002_integrity
Revises: 0001_baseline
"""

import logging
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0002_integrity"
down_revision: str | None = "0001_baseline"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

logger = logging.getLogger("alembic.runtime.migration")

# Reflected FKs are unnamed in SQLite; this gives them stable names so batch
# mode can drop and recreate them.
_NAMING = {"fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s"}

# (child table, fk column, parent table, ON DELETE)
_FOREIGN_KEYS: tuple[tuple[str, str, str, str], ...] = (
    ("playlist_items", "playlist_id", "playlists", "CASCADE"),
    ("playlist_items", "video_id", "videos", "CASCADE"),
    ("video_embeddings", "video_id", "videos", "CASCADE"),
    ("video_ai_meta", "video_id", "videos", "CASCADE"),
    ("video_ai_chat", "video_id", "videos", "CASCADE"),
    ("video_ai_chat_messages", "video_id", "videos", "CASCADE"),
    ("ai_jobs", "video_id", "videos", "CASCADE"),
    ("ai_jobs", "catalog_video_id", "channel_catalog_videos", "CASCADE"),
    ("channel_catalog_videos", "catalog_id", "channel_catalogs", "CASCADE"),
    ("channel_catalog_skips", "catalog_id", "channel_catalogs", "CASCADE"),
    (
        "channel_catalog_embeddings",
        "catalog_video_id",
        "channel_catalog_videos",
        "CASCADE",
    ),
    ("download_jobs", "video_id", "videos", "SET NULL"),
    ("download_jobs", "replace_video_id", "videos", "SET NULL"),
    ("download_jobs", "playlist_id", "playlists", "SET NULL"),
    ("openrouter_usage", "video_id", "videos", "SET NULL"),
    ("playlists", "cover_video_id", "videos", "SET NULL"),
)

# Tables whose ids are referenced from other tables or exposed to clients.
_AUTOINCREMENT_TABLES = frozenset(
    {
        "videos",
        "playlists",
        "download_jobs",
        "channel_catalogs",
        "channel_catalog_videos",
        "ai_jobs",
    }
)

# (index name, table, columns, unique): the baseline indexes plus the new ones.
_INDEXES: tuple[tuple[str, str, tuple[str, ...], bool], ...] = (
    ("ix_ai_categories_name", "ai_categories", ("name",), True),
    (
        "ix_channel_autodownloads_channel_url",
        "channel_autodownloads",
        ("channel_url",),
        True,
    ),
    ("ix_channel_autodownloads_enabled", "channel_autodownloads", ("enabled",), False),
    ("ix_channel_catalogs_channel_name", "channel_catalogs", ("channel_name",), False),
    ("ix_channel_catalogs_channel_url", "channel_catalogs", ("channel_url",), True),
    ("ix_channel_catalogs_status", "channel_catalogs", ("status",), False),
    ("ix_openrouter_usage_created_at", "openrouter_usage", ("created_at",), False),
    ("ix_openrouter_usage_kind", "openrouter_usage", ("kind",), False),
    ("ix_openrouter_usage_video_id", "openrouter_usage", ("video_id",), False),
    ("ix_playlists_created_at", "playlists", ("created_at",), False),
    ("ix_playlists_position", "playlists", ("position",), False),
    ("ix_videos_added_at", "videos", ("added_at",), False),
    ("ix_videos_channel", "videos", ("channel",), False),
    ("ix_videos_file_path", "videos", ("file_path",), True),
    ("ix_videos_needs_review", "videos", ("needs_review",), False),
    ("ix_videos_subtitles_pending", "videos", ("subtitles_pending",), False),
    ("ix_videos_title", "videos", ("title",), False),
    (
        "ix_channel_catalog_skips_catalog_id",
        "channel_catalog_skips",
        ("catalog_id",),
        False,
    ),
    ("ix_channel_catalog_skips_yt_id", "channel_catalog_skips", ("yt_id",), False),
    (
        "ix_channel_catalog_videos_catalog_id",
        "channel_catalog_videos",
        ("catalog_id",),
        False,
    ),
    (
        "ix_channel_catalog_videos_position",
        "channel_catalog_videos",
        ("position",),
        False,
    ),
    ("ix_channel_catalog_videos_yt_id", "channel_catalog_videos", ("yt_id",), False),
    ("ix_download_jobs_playlist_id", "download_jobs", ("playlist_id",), False),
    ("ix_playlist_items_playlist_id", "playlist_items", ("playlist_id",), False),
    ("ix_playlist_items_video_id", "playlist_items", ("video_id",), False),
    ("ix_video_ai_chat_messages_role", "video_ai_chat_messages", ("role",), False),
    (
        "ix_video_ai_chat_messages_video_id",
        "video_ai_chat_messages",
        ("video_id",),
        False,
    ),
    ("ix_video_ai_meta_embed_status", "video_ai_meta", ("embed_status",), False),
    ("ix_video_embeddings_chunk_index", "video_embeddings", ("chunk_index",), False),
    ("ix_video_embeddings_video_id", "video_embeddings", ("video_id",), False),
    ("ix_ai_jobs_catalog_video_id", "ai_jobs", ("catalog_video_id",), False),
    ("ix_ai_jobs_kind", "ai_jobs", ("kind",), False),
    ("ix_ai_jobs_run_after", "ai_jobs", ("run_after",), False),
    ("ix_ai_jobs_status", "ai_jobs", ("status",), False),
    ("ix_ai_jobs_video_id", "ai_jobs", ("video_id",), False),
    (
        "ix_channel_catalog_embeddings_catalog_video_id",
        "channel_catalog_embeddings",
        ("catalog_video_id",),
        True,
    ),
    # New in this revision.
    ("ix_download_jobs_status", "download_jobs", ("status",), False),
    ("ix_download_jobs_video_id", "download_jobs", ("video_id",), False),
    (
        "ix_download_jobs_replace_video_id",
        "download_jobs",
        ("replace_video_id",),
        False,
    ),
    ("ix_videos_source_url", "videos", ("source_url",), False),
    (
        "ix_ai_jobs_video_id_kind_status",
        "ai_jobs",
        ("video_id", "kind", "status"),
        False,
    ),
)

_UNIQUE_PLAYLIST_ITEM = "uq_playlist_items_pair"


def _fk_name(table: str, column: str, parent: str) -> str:
    return f"fk_{table}_{column}_{parent}"


def _log(what: str, count: int) -> None:
    if count:
        logger.warning("0002_integrity: %s %d row(s)", what, count)


def _repair_data(bind: sa.engine.Connection) -> None:
    """Make existing rows satisfy the constraints added below."""
    for table, column, parent, ondelete in _FOREIGN_KEYS:
        orphan = f"{column} IS NOT NULL AND {column} NOT IN (SELECT id FROM {parent})"  # noqa: S608 - identifiers come from _FOREIGN_KEYS
        if ondelete == "CASCADE":
            result = bind.execute(
                sa.text(f"DELETE FROM {table} WHERE {orphan}")  # noqa: S608 - identifiers come from _FOREIGN_KEYS
            )
            _log(f"deleted orphaned {table}.{column} ->{parent}:", result.rowcount)
        else:
            result = bind.execute(
                sa.text(f"UPDATE {table} SET {column} = NULL WHERE {orphan}")  # noqa: S608 - identifiers come from _FOREIGN_KEYS
            )
            _log(f"nulled dangling {table}.{column} ->{parent}:", result.rowcount)

    # Keep the lowest position (then lowest id) of each (playlist, video) pair.
    result = bind.execute(
        sa.text(
            "DELETE FROM playlist_items WHERE id NOT IN ("
            "SELECT id FROM ("
            "SELECT id, ROW_NUMBER() OVER ("
            "PARTITION BY playlist_id, video_id ORDER BY position, id"
            ") AS rn FROM playlist_items) WHERE rn = 1)"
        )
    )
    _log("collapsed duplicate playlist_items:", result.rowcount)


def _rebuild(table: str, *, unique_playlist_pair: bool = False) -> None:
    """Rebuild ``table`` with the FKs / AUTOINCREMENT declared for it."""
    wanted = [fk for fk in _FOREIGN_KEYS if fk[0] == table]
    wanted_columns = {column for _, column, _, _ in wanted}
    existing = sa.inspect(op.get_bind()).get_foreign_keys(table)
    rows = op.get_bind().execute(sa.text(f"SELECT count(*) FROM {table}")).scalar()  # noqa: S608 - table names come from the constants above
    logger.info("0002_integrity: rebuilding %s (%d rows)", table, rows)
    kwargs = {"sqlite_autoincrement": True} if table in _AUTOINCREMENT_TABLES else {}
    with op.batch_alter_table(
        table, recreate="always", naming_convention=_NAMING, table_kwargs=kwargs
    ) as batch:
        for fk in existing:
            columns = fk["constrained_columns"]
            if len(columns) == 1 and columns[0] in wanted_columns:
                batch.drop_constraint(
                    _fk_name(table, columns[0], fk["referred_table"]),
                    type_="foreignkey",
                )
        for _, column, parent, ondelete in wanted:
            batch.create_foreign_key(
                _fk_name(table, column, parent),
                parent,
                [column],
                ["id"],
                ondelete=ondelete,
            )
        if unique_playlist_pair:
            batch.create_unique_constraint(
                _UNIQUE_PLAYLIST_ITEM, ["playlist_id", "video_id"]
            )


def upgrade() -> None:
    bind = op.get_bind()
    _repair_data(bind)

    tables = {fk[0] for fk in _FOREIGN_KEYS} | _AUTOINCREMENT_TABLES
    logger.info("0002_integrity: rebuilding %d tables", len(tables))
    for table in sorted(tables):
        _rebuild(table, unique_playlist_pair=(table == "playlist_items"))

    for name, table, columns, unique in _INDEXES:
        op.create_index(name, table, list(columns), unique=unique, if_not_exists=True)


def downgrade() -> None:
    raise NotImplementedError(
        "Horde migrations are forward-only. To go back, restore horde.db from "
        "a backup taken before the upgrade (see docs/design/sqlite-and-migrations.md)."
    )
