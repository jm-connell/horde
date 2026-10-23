"""Two-step sign-in (TOTP) with recovery codes.

``users.totp_secret`` (base32; with ``totp_enabled_at`` empty it is an enrollment
that has not been confirmed yet), ``users.totp_enabled_at`` and
``users.totp_last_step`` (the newest accepted 30 second step, so a code cannot be
replayed). ``user_recovery_codes`` holds one keyed hash per unused recovery code.
``user_sessions.reauth_at`` is when the session last proved the password (a
sign-in, or ``POST /api/auth/reauth``); the sensitive administrator actions need
it within ten minutes. Sessions that exist at upgrade have none, so they ask
once.

Plain ADD COLUMNs and a new table: neither ``users`` nor ``user_sessions`` is
rebuilt, so nothing that depends on them (the FTS5 triggers on ``videos``) is
touched. Every account starts with two-step sign-in off.

Revision ID: 0016_two_factor
Revises: 0015_user_watch_time
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0016_two_factor"
down_revision: str | None = "0015_user_watch_time"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "user_recovery_codes",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("code_hash", sa.String(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name="fk_user_recovery_codes_user_id_users",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "user_id", "code_hash", name="uq_user_recovery_codes_user_id_code_hash"
        ),
        sqlite_autoincrement=True,
    )
    with op.batch_alter_table("user_recovery_codes", schema=None) as batch_op:
        batch_op.create_index(
            batch_op.f("ix_user_recovery_codes_user_id"), ["user_id"], unique=False
        )

    with op.batch_alter_table("users", schema=None) as batch_op:
        batch_op.add_column(sa.Column("totp_secret", sa.String(), nullable=True))
        batch_op.add_column(sa.Column("totp_enabled_at", sa.DateTime(), nullable=True))
        batch_op.add_column(sa.Column("totp_last_step", sa.Integer(), nullable=True))

    with op.batch_alter_table("user_sessions", schema=None) as batch_op:
        batch_op.add_column(sa.Column("reauth_at", sa.DateTime(), nullable=True))


def downgrade() -> None:
    raise NotImplementedError(
        "Horde migrations are forward-only. To go back, restore horde.db from "
        "a backup taken before the upgrade (see docs/design/sqlite-and-migrations.md)."
    )
