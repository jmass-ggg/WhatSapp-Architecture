from __future__ import annotations

from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from app.models.channel import Channel, ChannelMember
from app.models.user import User


def get_channel(db: Session, channel_id: UUID, *, for_update: bool = False) -> Channel | None:
    statement = select(Channel).where(Channel.id == channel_id)
    if for_update:
        # Lock the row and overwrite any already-loaded copy: a request that waited on this
        # lock must see what the request holding it committed (e.g. the Matrix room ID).
        statement = statement.with_for_update().execution_options(populate_existing=True)
    return db.scalar(statement)


def get_channel_by_creation_key(db: Session, creation_key: str) -> Channel | None:
    return db.scalar(select(Channel).where(Channel.creation_key == creation_key))


def list_channels(db: Session, *, statuses: tuple[str, ...]) -> list[Channel]:
    return list(
        db.scalars(
            select(Channel).where(Channel.status.in_(statuses)).order_by(Channel.created_at.asc())
        )
    )


def get_membership(db: Session, channel_id: UUID, user_id: UUID) -> ChannelMember | None:
    return db.scalar(
        select(ChannelMember).where(
            ChannelMember.channel_id == channel_id, ChannelMember.user_id == user_id
        )
    )


def memberships_for_user(db: Session, user_id: UUID) -> dict[UUID, ChannelMember]:
    rows = db.scalars(select(ChannelMember).where(ChannelMember.user_id == user_id))
    return {row.channel_id: row for row in rows}


def joined_counts(db: Session, channel_ids: list[UUID]) -> dict[UUID, int]:
    if not channel_ids:
        return {}
    rows = db.execute(
        select(ChannelMember.channel_id, func.count(ChannelMember.id))
        .where(ChannelMember.channel_id.in_(channel_ids), ChannelMember.status == "joined")
        .group_by(ChannelMember.channel_id)
    )
    return {channel_id: count for channel_id, count in rows}


def list_members(db: Session, channel_id: UUID) -> list[ChannelMember]:
    return list(
        db.scalars(
            select(ChannelMember)
            .options(selectinload(ChannelMember.user).selectinload(User.profile))
            .where(ChannelMember.channel_id == channel_id)
            .order_by(ChannelMember.created_at.asc())
        )
    )
