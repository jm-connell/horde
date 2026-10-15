"""Baseline: the schema as it stood when Alembic was adopted.

Revision ID: 0001_baseline
Revises:
Create Date: 2026-10-15 08:42:00.117777
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0001_baseline"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Pre-Alembic installs are adopted into this revision after the legacy
    # migrator ran; their tables already exist and are left alone (missing
    # indexes are added by 0002_integrity). A fresh database has none.
    existing = set(sa.inspect(op.get_bind()).get_table_names())

    if "ai_categories" not in existing:
        op.create_table(
            "ai_categories",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("name", sa.String(), nullable=False),
            sa.Column("blurb", sa.String(), nullable=True),
            sa.Column("embedding", sa.LargeBinary(), nullable=False),
            sa.Column("dim", sa.Integer(), nullable=False),
            sa.Column("model", sa.String(), nullable=False),
            sa.Column("updated_at", sa.DateTime(), nullable=False),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index(
            op.f("ix_ai_categories_name"), "ai_categories", ["name"], unique=True
        )

    if "channel_autodownloads" not in existing:
        op.create_table(
            "channel_autodownloads",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("channel_url", sa.String(), nullable=False),
            sa.Column("channel_name", sa.String(), nullable=True),
            sa.Column("enabled", sa.Boolean(), nullable=False),
            sa.Column("previous_mode", sa.String(), nullable=False),
            sa.Column("previous_count", sa.Integer(), nullable=True),
            sa.Column("quality_preset", sa.String(), nullable=False),
            sa.Column("include_completed_streams", sa.Boolean(), nullable=False),
            sa.Column("anchor_ready", sa.Boolean(), nullable=False),
            sa.Column("updated_at", sa.DateTime(), nullable=False),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index(
            op.f("ix_channel_autodownloads_channel_url"),
            "channel_autodownloads",
            ["channel_url"],
            unique=True,
        )
        op.create_index(
            op.f("ix_channel_autodownloads_enabled"),
            "channel_autodownloads",
            ["enabled"],
            unique=False,
        )

    if "channel_catalogs" not in existing:
        op.create_table(
            "channel_catalogs",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("channel_url", sa.String(), nullable=False),
            sa.Column("channel_name", sa.String(), nullable=True),
            sa.Column(
                "status",
                sa.Enum(
                    "idle",
                    "queued",
                    "indexing",
                    "ready",
                    "error",
                    name="channelcatalogstatus",
                ),
                nullable=False,
            ),
            sa.Column("indexed_count", sa.Integer(), nullable=False),
            sa.Column("channel_total", sa.Integer(), nullable=True),
            sa.Column("complete", sa.Boolean(), nullable=False),
            sa.Column("max_videos", sa.Integer(), nullable=False),
            sa.Column("direct_youtube_search", sa.Boolean(), nullable=True),
            sa.Column("phase", sa.String(), nullable=True),
            sa.Column("last_error", sa.String(), nullable=True),
            sa.Column("started_at", sa.DateTime(), nullable=True),
            sa.Column("finished_at", sa.DateTime(), nullable=True),
            sa.Column("updated_at", sa.DateTime(), nullable=False),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index(
            op.f("ix_channel_catalogs_channel_name"),
            "channel_catalogs",
            ["channel_name"],
            unique=False,
        )
        op.create_index(
            op.f("ix_channel_catalogs_channel_url"),
            "channel_catalogs",
            ["channel_url"],
            unique=True,
        )
        op.create_index(
            op.f("ix_channel_catalogs_status"),
            "channel_catalogs",
            ["status"],
            unique=False,
        )

    if "openrouter_usage" not in existing:
        op.create_table(
            "openrouter_usage",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("kind", sa.String(), nullable=False),
            sa.Column("cost", sa.Float(), nullable=False),
            sa.Column("model", sa.String(), nullable=True),
            sa.Column("video_id", sa.Integer(), nullable=True),
            sa.Column("prompt_tokens", sa.Integer(), nullable=True),
            sa.Column("completion_tokens", sa.Integer(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index(
            op.f("ix_openrouter_usage_created_at"),
            "openrouter_usage",
            ["created_at"],
            unique=False,
        )
        op.create_index(
            op.f("ix_openrouter_usage_kind"), "openrouter_usage", ["kind"], unique=False
        )
        op.create_index(
            op.f("ix_openrouter_usage_video_id"),
            "openrouter_usage",
            ["video_id"],
            unique=False,
        )

    if "playlists" not in existing:
        op.create_table(
            "playlists",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("name", sa.String(), nullable=False),
            sa.Column("description", sa.String(), nullable=True),
            sa.Column(
                "source_type",
                sa.Enum("user", "youtube", name="playlistsource"),
                nullable=False,
            ),
            sa.Column("source_url", sa.String(), nullable=True),
            sa.Column("subscribed", sa.Boolean(), nullable=False),
            sa.Column("quality_preset", sa.String(), nullable=True),
            sa.Column("last_synced_at", sa.DateTime(), nullable=True),
            sa.Column("sync_error", sa.String(), nullable=True),
            sa.Column("position", sa.Integer(), nullable=False),
            sa.Column("cover_video_id", sa.Integer(), nullable=True),
            sa.Column("cover_path", sa.String(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index(
            op.f("ix_playlists_created_at"), "playlists", ["created_at"], unique=False
        )
        op.create_index(
            op.f("ix_playlists_position"), "playlists", ["position"], unique=False
        )

    if "videos" not in existing:
        op.create_table(
            "videos",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("title", sa.String(), nullable=False),
            sa.Column("channel", sa.String(), nullable=True),
            sa.Column("channel_url", sa.String(), nullable=True),
            sa.Column("tags", sa.String(), nullable=False),
            sa.Column("description", sa.String(), nullable=True),
            sa.Column("notes", sa.String(), nullable=True),
            sa.Column("source_url", sa.String(), nullable=True),
            sa.Column("thumbnail_path", sa.String(), nullable=True),
            sa.Column("sprite_path", sa.String(), nullable=True),
            sa.Column("subtitles", sa.String(), nullable=False),
            sa.Column("file_path", sa.String(), nullable=False),
            sa.Column("duration_sec", sa.Float(), nullable=True),
            sa.Column("file_size", sa.Integer(), nullable=True),
            sa.Column("width_px", sa.Integer(), nullable=True),
            sa.Column("height_px", sa.Integer(), nullable=True),
            sa.Column("view_count", sa.Integer(), nullable=True),
            sa.Column("channel_subscriber_count", sa.Integer(), nullable=True),
            sa.Column("published_at", sa.DateTime(), nullable=True),
            sa.Column("added_at", sa.DateTime(), nullable=False),
            sa.Column("last_position_sec", sa.Float(), nullable=False),
            sa.Column("last_watched_at", sa.DateTime(), nullable=True),
            sa.Column("needs_review", sa.Boolean(), nullable=False),
            sa.Column("platform", sa.String(), nullable=True),
            sa.Column(
                "status",
                sa.Enum("downloading", "ready", "error", name="videostatus"),
                nullable=False,
            ),
            sa.Column("frame_rate", sa.Float(), nullable=True),
            sa.Column("metadata_synced_at", sa.DateTime(), nullable=True),
            sa.Column("source_title", sa.String(), nullable=True),
            sa.Column("source_description", sa.String(), nullable=True),
            sa.Column("title_is_custom", sa.Boolean(), nullable=False),
            sa.Column("description_is_custom", sa.Boolean(), nullable=False),
            sa.Column("subtitles_pending", sa.Boolean(), nullable=False),
            sa.Column("subtitles_retry_after", sa.DateTime(), nullable=True),
            sa.Column("subtitles_fetch_attempts", sa.Integer(), nullable=False),
            sa.Column("source_chapters", sa.String(), nullable=False),
            sa.Column("vcodec", sa.String(), nullable=True),
            sa.Column("acodec", sa.String(), nullable=True),
            sa.Column("codec_string", sa.String(), nullable=True),
            sa.Column("bit_depth", sa.Integer(), nullable=True),
            sa.Column("is_hdr", sa.Boolean(), nullable=False),
            sa.Column("media_probed_at", sa.DateTime(), nullable=True),
            sa.Column("compat_path", sa.String(), nullable=True),
            sa.Column("compat_size", sa.Integer(), nullable=True),
            sa.Column("compat_source", sa.String(), nullable=True),
            sa.Column("compat_error", sa.String(), nullable=True),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index(
            op.f("ix_videos_added_at"), "videos", ["added_at"], unique=False
        )
        op.create_index(op.f("ix_videos_channel"), "videos", ["channel"], unique=False)
        op.create_index(
            op.f("ix_videos_file_path"), "videos", ["file_path"], unique=True
        )
        op.create_index(
            op.f("ix_videos_needs_review"), "videos", ["needs_review"], unique=False
        )
        op.create_index(
            op.f("ix_videos_subtitles_pending"),
            "videos",
            ["subtitles_pending"],
            unique=False,
        )
        op.create_index(op.f("ix_videos_title"), "videos", ["title"], unique=False)

    if "channel_catalog_skips" not in existing:
        op.create_table(
            "channel_catalog_skips",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("catalog_id", sa.Integer(), nullable=False),
            sa.Column("yt_id", sa.String(), nullable=False),
            sa.Column("reason", sa.String(), nullable=False),
            sa.Column("skipped_at", sa.DateTime(), nullable=False),
            sa.ForeignKeyConstraint(
                ["catalog_id"],
                ["channel_catalogs.id"],
            ),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("catalog_id", "yt_id"),
        )
        op.create_index(
            op.f("ix_channel_catalog_skips_catalog_id"),
            "channel_catalog_skips",
            ["catalog_id"],
            unique=False,
        )
        op.create_index(
            op.f("ix_channel_catalog_skips_yt_id"),
            "channel_catalog_skips",
            ["yt_id"],
            unique=False,
        )

    if "channel_catalog_videos" not in existing:
        op.create_table(
            "channel_catalog_videos",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("catalog_id", sa.Integer(), nullable=False),
            sa.Column("yt_id", sa.String(), nullable=False),
            sa.Column("url", sa.String(), nullable=False),
            sa.Column("title", sa.String(), nullable=True),
            sa.Column("duration", sa.Float(), nullable=True),
            sa.Column("view_count", sa.Integer(), nullable=True),
            sa.Column("published_at", sa.String(), nullable=True),
            sa.Column("thumbnail_url", sa.String(), nullable=True),
            sa.Column("description", sa.String(), nullable=True),
            sa.Column("live_status", sa.String(), nullable=True),
            sa.Column("position", sa.Integer(), nullable=False),
            sa.Column("indexed_at", sa.DateTime(), nullable=False),
            sa.ForeignKeyConstraint(
                ["catalog_id"],
                ["channel_catalogs.id"],
            ),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("catalog_id", "yt_id"),
        )
        op.create_index(
            op.f("ix_channel_catalog_videos_catalog_id"),
            "channel_catalog_videos",
            ["catalog_id"],
            unique=False,
        )
        op.create_index(
            op.f("ix_channel_catalog_videos_position"),
            "channel_catalog_videos",
            ["position"],
            unique=False,
        )
        op.create_index(
            op.f("ix_channel_catalog_videos_yt_id"),
            "channel_catalog_videos",
            ["yt_id"],
            unique=False,
        )

    if "download_jobs" not in existing:
        op.create_table(
            "download_jobs",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("url", sa.String(), nullable=False),
            sa.Column("quality_preset", sa.String(), nullable=False),
            sa.Column("available_presets_json", sa.String(), nullable=True),
            sa.Column(
                "status",
                sa.Enum(
                    "queued",
                    "downloading",
                    "completed",
                    "error",
                    "cancelled",
                    name="jobstatus",
                ),
                nullable=False,
            ),
            sa.Column("progress", sa.Float(), nullable=False),
            sa.Column("title", sa.String(), nullable=True),
            sa.Column("title_override", sa.String(), nullable=True),
            sa.Column("channel", sa.String(), nullable=True),
            sa.Column("channel_override", sa.String(), nullable=True),
            sa.Column("thumbnail_url", sa.String(), nullable=True),
            sa.Column("notes_pending", sa.String(), nullable=True),
            sa.Column("paused", sa.Boolean(), nullable=False),
            sa.Column("normalize_volume", sa.Boolean(), nullable=False),
            sa.Column("video_codec", sa.String(), nullable=False),
            sa.Column("destination", sa.String(), nullable=False),
            sa.Column("device_file_path", sa.String(), nullable=True),
            sa.Column("replace_video_id", sa.Integer(), nullable=True),
            sa.Column("playlist_id", sa.Integer(), nullable=True),
            sa.Column("error", sa.String(), nullable=True),
            sa.Column("error_kind", sa.String(), nullable=True),
            sa.Column("video_id", sa.Integer(), nullable=True),
            sa.Column("file_size", sa.Integer(), nullable=True),
            sa.Column("height_px", sa.Integer(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.ForeignKeyConstraint(
                ["replace_video_id"],
                ["videos.id"],
            ),
            sa.ForeignKeyConstraint(
                ["video_id"],
                ["videos.id"],
            ),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index(
            op.f("ix_download_jobs_playlist_id"),
            "download_jobs",
            ["playlist_id"],
            unique=False,
        )

    if "playlist_items" not in existing:
        op.create_table(
            "playlist_items",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("playlist_id", sa.Integer(), nullable=False),
            sa.Column("video_id", sa.Integer(), nullable=False),
            sa.Column("position", sa.Integer(), nullable=False),
            sa.ForeignKeyConstraint(
                ["playlist_id"],
                ["playlists.id"],
            ),
            sa.ForeignKeyConstraint(
                ["video_id"],
                ["videos.id"],
            ),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index(
            op.f("ix_playlist_items_playlist_id"),
            "playlist_items",
            ["playlist_id"],
            unique=False,
        )
        op.create_index(
            op.f("ix_playlist_items_video_id"),
            "playlist_items",
            ["video_id"],
            unique=False,
        )

    if "video_ai_chat" not in existing:
        op.create_table(
            "video_ai_chat",
            sa.Column("video_id", sa.Integer(), nullable=False),
            sa.Column("updated_at", sa.DateTime(), nullable=False),
            sa.ForeignKeyConstraint(
                ["video_id"],
                ["videos.id"],
            ),
            sa.PrimaryKeyConstraint("video_id"),
        )

    if "video_ai_chat_messages" not in existing:
        op.create_table(
            "video_ai_chat_messages",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("video_id", sa.Integer(), nullable=False),
            sa.Column("role", sa.String(), nullable=False),
            sa.Column("content", sa.String(), nullable=False),
            sa.Column("cost", sa.Float(), nullable=True),
            sa.Column("model", sa.String(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.ForeignKeyConstraint(
                ["video_id"],
                ["videos.id"],
            ),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index(
            op.f("ix_video_ai_chat_messages_role"),
            "video_ai_chat_messages",
            ["role"],
            unique=False,
        )
        op.create_index(
            op.f("ix_video_ai_chat_messages_video_id"),
            "video_ai_chat_messages",
            ["video_id"],
            unique=False,
        )

    if "video_ai_meta" not in existing:
        op.create_table(
            "video_ai_meta",
            sa.Column("video_id", sa.Integer(), nullable=False),
            sa.Column("embed_status", sa.String(), nullable=False),
            sa.Column("content_hash", sa.String(), nullable=False),
            sa.Column("summary", sa.String(), nullable=True),
            sa.Column("summary_length", sa.String(), nullable=True),
            sa.Column("summary_cost", sa.Float(), nullable=True),
            sa.Column("summary_model", sa.String(), nullable=True),
            sa.Column("ai_tags", sa.String(), nullable=False),
            sa.Column("user_tags", sa.String(), nullable=False),
            sa.Column("tags_enriched_at", sa.DateTime(), nullable=True),
            sa.Column("tags_locked", sa.Boolean(), nullable=False),
            sa.Column("embed_error", sa.String(), nullable=True),
            sa.Column("chapters", sa.String(), nullable=True),
            sa.Column("chapters_skip_reason", sa.String(), nullable=True),
            sa.Column("updated_at", sa.DateTime(), nullable=False),
            sa.ForeignKeyConstraint(
                ["video_id"],
                ["videos.id"],
            ),
            sa.PrimaryKeyConstraint("video_id"),
        )
        op.create_index(
            op.f("ix_video_ai_meta_embed_status"),
            "video_ai_meta",
            ["embed_status"],
            unique=False,
        )

    if "video_embeddings" not in existing:
        op.create_table(
            "video_embeddings",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("video_id", sa.Integer(), nullable=False),
            sa.Column("chunk_index", sa.Integer(), nullable=False),
            sa.Column("model", sa.String(), nullable=False),
            sa.Column("dim", sa.Integer(), nullable=False),
            sa.Column("vector", sa.LargeBinary(), nullable=False),
            sa.Column("content_hash", sa.String(), nullable=False),
            sa.Column("updated_at", sa.DateTime(), nullable=False),
            sa.ForeignKeyConstraint(
                ["video_id"],
                ["videos.id"],
            ),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index(
            op.f("ix_video_embeddings_chunk_index"),
            "video_embeddings",
            ["chunk_index"],
            unique=False,
        )
        op.create_index(
            op.f("ix_video_embeddings_video_id"),
            "video_embeddings",
            ["video_id"],
            unique=False,
        )

    if "ai_jobs" not in existing:
        op.create_table(
            "ai_jobs",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column(
                "kind",
                sa.Enum(
                    "embed_video",
                    "enrich_tags",
                    "refresh_categories",
                    "embed_catalog_video",
                    "summarize",
                    "chapters",
                    name="aijobkind",
                ),
                nullable=False,
            ),
            sa.Column("video_id", sa.Integer(), nullable=True),
            sa.Column("catalog_video_id", sa.Integer(), nullable=True),
            sa.Column(
                "status",
                sa.Enum(
                    "queued",
                    "running",
                    "completed",
                    "error",
                    "cancelled",
                    name="aijobstatus",
                ),
                nullable=False,
            ),
            sa.Column("attempts", sa.Integer(), nullable=False),
            sa.Column("run_after", sa.DateTime(), nullable=True),
            sa.Column("error", sa.String(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.Column("updated_at", sa.DateTime(), nullable=False),
            sa.ForeignKeyConstraint(
                ["catalog_video_id"],
                ["channel_catalog_videos.id"],
            ),
            sa.ForeignKeyConstraint(
                ["video_id"],
                ["videos.id"],
            ),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index(
            op.f("ix_ai_jobs_catalog_video_id"),
            "ai_jobs",
            ["catalog_video_id"],
            unique=False,
        )
        op.create_index(op.f("ix_ai_jobs_kind"), "ai_jobs", ["kind"], unique=False)
        op.create_index(
            op.f("ix_ai_jobs_run_after"), "ai_jobs", ["run_after"], unique=False
        )
        op.create_index(op.f("ix_ai_jobs_status"), "ai_jobs", ["status"], unique=False)
        op.create_index(
            op.f("ix_ai_jobs_video_id"), "ai_jobs", ["video_id"], unique=False
        )

    if "channel_catalog_embeddings" not in existing:
        op.create_table(
            "channel_catalog_embeddings",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("catalog_video_id", sa.Integer(), nullable=False),
            sa.Column("model", sa.String(), nullable=False),
            sa.Column("dim", sa.Integer(), nullable=False),
            sa.Column("vector", sa.LargeBinary(), nullable=False),
            sa.Column("content_hash", sa.String(), nullable=False),
            sa.Column("updated_at", sa.DateTime(), nullable=False),
            sa.ForeignKeyConstraint(
                ["catalog_video_id"],
                ["channel_catalog_videos.id"],
            ),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index(
            op.f("ix_channel_catalog_embeddings_catalog_video_id"),
            "channel_catalog_embeddings",
            ["catalog_video_id"],
            unique=True,
        )


def downgrade() -> None:
    raise NotImplementedError(
        "Horde migrations are forward-only. To go back, restore horde.db from "
        "a backup taken before the upgrade (see docs/design/sqlite-and-migrations.md)."
    )
