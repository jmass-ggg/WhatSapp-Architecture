from __future__ import annotations

from datetime import datetime
from uuid import UUID, uuid4

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    String,
    Uuid,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base
from app.models.user import User


class UserConnection(Base):
    __tablename__ = "user_connections"
    __table_args__ = (
        CheckConstraint(
            "requester_id <> recipient_id",
            name="ck_user_connections_no_self_request",
        ),
        CheckConstraint(
            "status IN ('pending', 'accepted', 'declined', 'blocked')",
            name="ck_user_connections_status",
        ),
        Index(
            "uq_user_connections_user_pair",
            func.least(text("requester_id"), text("recipient_id")),
            func.greatest(text("requester_id"), text("recipient_id")),
            unique=True,
        ),
        Index("ix_user_connections_requester_status", "requester_id", "status"),
        Index("ix_user_connections_recipient_status", "recipient_id", "status"),
    )

    id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid4)
    requester_id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    recipient_id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="pending")
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
    accepted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    requester: Mapped[User] = relationship(foreign_keys=[requester_id])
    recipient: Mapped[User] = relationship(foreign_keys=[recipient_id])
