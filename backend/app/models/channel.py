from __future__ import annotations

from datetime import datetime
from uuid import UUID, uuid4

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    String,
    UniqueConstraint,
    Uuid,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base
from app.models.user import User


CHANNEL_CATEGORIES: tuple[str, ...] = (
    "general",
    "announcements",
    "engineering",
    "technology",
    "finance",
    "gaming",
    "education",
    "hr",
    "product",
)
CHANNEL_STATUSES: tuple[str, ...] = ("provisioning", "active", "archived")
#: owner = creator (full control), admin = publishes and moderates, member = reads and reacts.
CHANNEL_MEMBER_ROLES: tuple[str, ...] = ("owner", "admin", "member")
CHANNEL_MEMBER_STATUSES: tuple[str, ...] = ("invited", "joined", "left", "removed")


def _sql_list(values: tuple[str, ...]) -> str:
    return ", ".join(f"'{value}'" for value in values)


class Channel(Base):
    """Application-wide community (broadcast channel) backed by one Synapse room.

    The backend is the only authority on which Matrix rooms are communities: a room is a
    community only when a row here references it, never because of its own room state.
    Names are not unique; the UUID is the identity.
    """

    __tablename__ = "channels"
    __table_args__ = (
        CheckConstraint(f"category IN ({_sql_list(CHANNEL_CATEGORIES)})", name="ck_channels_category"),
        CheckConstraint(f"status IN ({_sql_list(CHANNEL_STATUSES)})", name="ck_channels_status"),
        Index("ix_channels_name_lower", func.lower(text("name"))),
        Index("ix_channels_status", "status"),
    )

    id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid4)
    matrix_room_id: Mapped[str | None] = mapped_column(String(255), unique=True, nullable=True)
    #: Client idempotency key for creation; a retry with the same key returns the same row.
    creation_key: Mapped[str | None] = mapped_column(String(64), unique=True, nullable=True)
    name: Mapped[str] = mapped_column(String(80), nullable=False)
    description: Mapped[str] = mapped_column(String(500), nullable=False, default="", server_default=text("''"))
    avatar_url: Mapped[str | None] = mapped_column(String(2048), nullable=True)
    category: Mapped[str] = mapped_column(String(40), nullable=False, default="general")
    creator_id: Mapped[UUID | None] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    is_verified: Mapped[bool] = mapped_column(default=False, server_default=text("false"), nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="provisioning")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

    creator: Mapped[User | None] = relationship(foreign_keys=[creator_id])
    members: Mapped[list[ChannelMember]] = relationship(
        back_populates="channel",
        cascade="all, delete-orphan",
    )


class ChannelMember(Base):
    """A user's subscription to a channel and their application-level channel role."""

    __tablename__ = "channel_members"
    __table_args__ = (
        UniqueConstraint("channel_id", "user_id", name="uq_channel_members_channel_user"),
        CheckConstraint(f"role IN ({_sql_list(CHANNEL_MEMBER_ROLES)})", name="ck_channel_members_role"),
        CheckConstraint(
            f"status IN ({_sql_list(CHANNEL_MEMBER_STATUSES)})",
            name="ck_channel_members_status",
        ),
        Index("ix_channel_members_user_status", "user_id", "status"),
        Index("ix_channel_members_channel_status", "channel_id", "status"),
    )

    id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid4)
    channel_id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("channels.id", ondelete="CASCADE"),
        nullable=False,
    )
    user_id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    role: Mapped[str] = mapped_column(String(20), nullable=False, default="member")
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="invited")
    joined_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

    channel: Mapped[Channel] = relationship(back_populates="members")
    user: Mapped[User] = relationship(foreign_keys=[user_id])
