"""Remove the obsolete profile organization label.

Revision ID: 0003_remove_profile_organization
Revises: 0002_user_connections
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "0003_remove_profile_organization"
down_revision: Union[str, None] = "0002_user_connections"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.drop_column("profiles", "organization")


def downgrade() -> None:
    op.add_column(
        "profiles",
        sa.Column("organization", sa.String(length=160), nullable=True),
    )
