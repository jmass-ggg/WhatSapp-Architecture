"""Add persisted user connections and remove organization membership.

Revision ID: 0002_user_connections
Revises: 0001_initial_schema
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "0002_user_connections"
down_revision: Union[str, None] = "0001_initial_schema"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "user_connections",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("requester_id", sa.Uuid(), nullable=False),
        sa.Column("recipient_id", sa.Uuid(), nullable=False),
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
        sa.Column("accepted_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "requester_id <> recipient_id",
            name="ck_user_connections_no_self_request",
        ),
        sa.CheckConstraint(
            "status IN ('pending', 'accepted', 'declined', 'blocked')",
            name="ck_user_connections_status",
        ),
        sa.ForeignKeyConstraint(["requester_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["recipient_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "uq_user_connections_user_pair",
        "user_connections",
        [
            sa.text("least(requester_id, recipient_id)"),
            sa.text("greatest(requester_id, recipient_id)"),
        ],
        unique=True,
    )
    op.create_index(
        "ix_user_connections_requester_status",
        "user_connections",
        ["requester_id", "status"],
    )
    op.create_index(
        "ix_user_connections_recipient_status",
        "user_connections",
        ["recipient_id", "status"],
    )

    op.drop_index("ix_users_organization_id", table_name="users")
    op.drop_constraint("users_organization_id_fkey", "users", type_="foreignkey")
    op.drop_column("users", "organization_id")
    op.drop_table("organizations")


def downgrade() -> None:
    op.create_table(
        "organizations",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("slug", sa.String(length=80), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("slug", name="uq_organizations_slug"),
    )
    op.add_column("users", sa.Column("organization_id", sa.Uuid(), nullable=True))
    op.create_foreign_key(
        "users_organization_id_fkey",
        "users",
        "organizations",
        ["organization_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index("ix_users_organization_id", "users", ["organization_id"])

    op.drop_index("ix_user_connections_recipient_status", table_name="user_connections")
    op.drop_index("ix_user_connections_requester_status", table_name="user_connections")
    op.drop_index("uq_user_connections_user_pair", table_name="user_connections")
    op.drop_table("user_connections")
