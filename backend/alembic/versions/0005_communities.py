"""Turn channels into communities: anyone creates, owner/admin/member roles, idempotent creation.

Revision ID: 0005_communities
Revises: 0004_channels
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "0005_communities"
down_revision: Union[str, None] = "0004_channels"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

NEW_CATEGORIES = (
    "general", "announcements", "engineering", "technology", "finance",
    "gaming", "education", "hr", "product",
)
OLD_CATEGORIES = ("general", "announcements", "engineering", "finance", "hr", "product")


def _sql_list(values: tuple[str, ...]) -> str:
    return ", ".join(f"'{value}'" for value in values)


def upgrade() -> None:
    # Names are no longer globally unique; communities are identified by ID only.
    op.drop_index("uq_channels_name_lower", table_name="channels")
    op.create_index("ix_channels_name_lower", "channels", [sa.text("lower(name)")])
    # Client-supplied idempotency key so a double-click or retry never creates two communities.
    op.add_column("channels", sa.Column("creation_key", sa.String(length=64), nullable=True))
    op.create_index("uq_channels_creation_key", "channels", ["creation_key"], unique=True)

    op.drop_constraint("ck_channels_category", "channels", type_="check")
    op.create_check_constraint(
        "ck_channels_category", "channels", f"category IN ({_sql_list(NEW_CATEGORIES)})"
    )

    op.drop_constraint("ck_channel_members_role", "channel_members", type_="check")
    op.execute("UPDATE channel_members SET role = 'member' WHERE role = 'subscriber'")
    op.execute(
        "UPDATE channel_members AS cm SET role = 'owner' FROM channels AS c "
        "WHERE cm.channel_id = c.id AND cm.user_id = c.creator_id AND cm.role = 'admin'"
    )
    op.create_check_constraint(
        "ck_channel_members_role", "channel_members", "role IN ('owner', 'admin', 'member')"
    )


def downgrade() -> None:
    op.drop_constraint("ck_channel_members_role", "channel_members", type_="check")
    op.execute("UPDATE channel_members SET role = 'admin' WHERE role = 'owner'")
    op.execute("UPDATE channel_members SET role = 'subscriber' WHERE role = 'member'")
    op.create_check_constraint(
        "ck_channel_members_role", "channel_members", "role IN ('admin', 'subscriber')"
    )

    op.drop_constraint("ck_channels_category", "channels", type_="check")
    op.execute(
        "UPDATE channels SET category = 'general' "
        f"WHERE category NOT IN ({_sql_list(OLD_CATEGORIES)})"
    )
    op.create_check_constraint(
        "ck_channels_category", "channels", f"category IN ({_sql_list(OLD_CATEGORIES)})"
    )

    op.drop_index("uq_channels_creation_key", table_name="channels")
    op.drop_column("channels", "creation_key")
    op.drop_index("ix_channels_name_lower", table_name="channels")
    # Duplicate names block the old unique index; suffix later duplicates with their ID.
    op.execute(
        "UPDATE channels AS c SET name = left(c.name, 60) || ' ' || left(c.id::text, 8) "
        "FROM (SELECT id, row_number() OVER (PARTITION BY lower(name) ORDER BY created_at) AS rn "
        "FROM channels) AS d WHERE d.id = c.id AND d.rn > 1"
    )
    op.create_index("uq_channels_name_lower", "channels", [sa.text("lower(name)")], unique=True)
