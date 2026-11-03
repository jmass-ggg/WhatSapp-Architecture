"""Add application-wide broadcast channels and channel memberships.

Revision ID: 0004_channels
Revises: 0003_remove_profile_organization
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "0004_channels"
down_revision: Union[str, None] = "0003_remove_profile_organization"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "channels",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("matrix_room_id", sa.String(length=255), nullable=True),
        sa.Column("name", sa.String(length=80), nullable=False),
        sa.Column("description", sa.String(length=500), server_default=sa.text("''"), nullable=False),
        sa.Column("avatar_url", sa.String(length=2048), nullable=True),
        sa.Column("category", sa.String(length=40), nullable=False),
        sa.Column("creator_id", sa.Uuid(), nullable=True),
        sa.Column("is_verified", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("status", sa.String(length=20), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.CheckConstraint(
            "category IN ('general', 'announcements', 'engineering', 'finance', 'hr', 'product')",
            name="ck_channels_category",
        ),
        sa.CheckConstraint(
            "status IN ('provisioning', 'active', 'archived')",
            name="ck_channels_status",
        ),
        sa.ForeignKeyConstraint(["creator_id"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("matrix_room_id", name="uq_channels_matrix_room_id"),
    )
    op.create_index("uq_channels_name_lower", "channels", [sa.text("lower(name)")], unique=True)
    op.create_index("ix_channels_status", "channels", ["status"])

    op.create_table(
        "channel_members",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("channel_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("role", sa.String(length=20), nullable=False),
        sa.Column("status", sa.String(length=20), nullable=False),
        sa.Column("joined_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.CheckConstraint("role IN ('admin', 'subscriber')", name="ck_channel_members_role"),
        sa.CheckConstraint(
            "status IN ('invited', 'joined', 'left', 'removed')",
            name="ck_channel_members_status",
        ),
        sa.ForeignKeyConstraint(["channel_id"], ["channels.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("channel_id", "user_id", name="uq_channel_members_channel_user"),
    )
    op.create_index("ix_channel_members_user_status", "channel_members", ["user_id", "status"])
    op.create_index("ix_channel_members_channel_status", "channel_members", ["channel_id", "status"])


def downgrade() -> None:
    op.drop_index("ix_channel_members_channel_status", table_name="channel_members")
    op.drop_index("ix_channel_members_user_status", table_name="channel_members")
    op.drop_table("channel_members")
    op.drop_index("ix_channels_status", table_name="channels")
    op.drop_index("uq_channels_name_lower", table_name="channels")
    op.drop_table("channels")
