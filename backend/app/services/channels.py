"""Communities (broadcast channels): PostgreSQL metadata plus Synapse room provisioning.

Roles
-----
* ``owner``  – the creator: publishes, edits the community, assigns admins, moderates, archives.
* ``admin``  – publishes and moderates ordinary members.
* ``member`` – reads and reacts.
Application administrators (``users.role = 'admin'``) hold owner-level rights everywhere.

Consistency model
-----------------
* PostgreSQL is the authority on *which* rooms are communities and on application roles.
* Synapse is the authority on room membership and enforces publishing rights through power
  levels; every membership change goes through the backend-only service identity.
* Rows are written only after the matching Synapse call succeeded. Reads of a single community
  (details, members) reconcile the membership table against the room's joined members, so a
  membership changed outside the API (or lost to a crash between the two systems) converges.
* Creation is idempotent per client ``request_id``: the row is reserved under that key first,
  then the room is created, then the row is activated; a retry with the same key resumes
  provisioning or returns the finished community instead of creating a second one.
"""
from __future__ import annotations

import logging
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from uuid import UUID

from fastapi import HTTPException, status
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.security import matrix_localpart
from app.integrations.matrix.client import (
    CHANNEL_MARKER_EVENT_TYPE,
    CHANNEL_MARKER_VERSION,
    CHANNEL_PUBLISHER_POWER_LEVEL,
    MatrixClient,
    MatrixConnectionError,
)
from app.models.channel import Channel, ChannelMember
from app.models.user import User
from app.repositories import channels as repository
from app.schemas.channel import (
    ChannelCreate,
    ChannelMemberRead,
    ChannelMemberRoleUpdate,
    ChannelMembershipRead,
    ChannelRead,
    ChannelUpdate,
)


logger = logging.getLogger("app.channels")

ACTIVE_MEMBER_STATUSES = ("invited", "joined")
PUBLISHER_ROLES = ("owner", "admin")


def matrix_user_id_for(user_id: UUID) -> str:
    return f"@{matrix_localpart(user_id)}:{settings.synapse_server_name}"


def app_user_id_for(matrix_user_id: str) -> UUID | None:
    """Inverse of :func:`matrix_user_id_for`; ``None`` for anything that is not an app user."""
    if not matrix_user_id.startswith("@u_"):
        return None
    localpart = matrix_user_id[1:].split(":", 1)[0]
    try:
        return UUID(hex=localpart[2:])
    except ValueError:
        return None


def is_app_admin(user: User) -> bool:
    return user.role == "admin"


def _not_found() -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Community not found")


def _forbidden(detail: str = "Insufficient permissions") -> HTTPException:
    return HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=detail)


@contextmanager
def _matrix_errors(action: str) -> Iterator[None]:
    try:
        yield
    except MatrixConnectionError as exc:
        logger.error("community_matrix_failure action=%s error=%s", action, exc)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="The messaging server could not complete this community operation",
        ) from exc


def _active(membership: ChannelMember | None) -> bool:
    return membership is not None and membership.status in ACTIVE_MEMBER_STATUSES


def can_edit(actor: User, membership: ChannelMember | None) -> bool:
    """Owner-level rights: edit info, assign admins, archive."""
    return is_app_admin(actor) or (_active(membership) and membership.role == "owner")


def can_manage(actor: User, membership: ChannelMember | None) -> bool:
    """Moderation rights: remove ordinary members."""
    return can_edit(actor, membership) or (_active(membership) and membership.role == "admin")


def can_publish(actor: User, membership: ChannelMember | None) -> bool:
    return (
        membership is not None
        and membership.status == "joined"
        and (membership.role in PUBLISHER_ROLES or is_app_admin(actor))
    )


def _visible(channel: Channel, actor: User) -> bool:
    if channel.status == "active":
        return True
    return channel.status == "provisioning" and (
        is_app_admin(actor) or channel.creator_id == actor.id
    )


def _load_visible(db: Session, channel_id: UUID, actor: User, *, for_update: bool = False) -> Channel:
    channel = repository.get_channel(db, channel_id, for_update=for_update)
    if channel is None or not _visible(channel, actor):
        raise _not_found()
    return channel


def to_read(channel: Channel, membership: ChannelMember | None, member_count: int, actor: User) -> ChannelRead:
    return ChannelRead(
        id=channel.id,
        matrix_room_id=channel.matrix_room_id,
        name=channel.name,
        description=channel.description,
        avatar_url=channel.avatar_url,
        category=channel.category,  # type: ignore[arg-type]
        creator_id=channel.creator_id,
        is_verified=channel.is_verified,
        status=channel.status,  # type: ignore[arg-type]
        created_at=channel.created_at,
        updated_at=channel.updated_at,
        member_count=member_count,
        membership=ChannelMembershipRead.model_validate(membership) if membership else None,
        can_manage=can_manage(actor, membership),
        can_edit=can_edit(actor, membership),
        can_publish=can_publish(actor, membership),
    )


def _member_read(row: ChannelMember) -> ChannelMemberRead:
    return ChannelMemberRead(
        user=row.user,  # type: ignore[arg-type]
        matrix_user_id=matrix_user_id_for(row.user_id),
        role=row.role,  # type: ignore[arg-type]
        status=row.status,  # type: ignore[arg-type]
        joined_at=row.joined_at,
    )


def _read_one(db: Session, channel: Channel, actor: User) -> ChannelRead:
    membership = repository.get_membership(db, channel.id, actor.id)
    count = repository.joined_counts(db, [channel.id]).get(channel.id, 0)
    return to_read(channel, membership, count, actor)


# --------------------------------------------------------------------------- reads


def list_channels(db: Session, actor: User) -> list[ChannelRead]:
    channels = [
        channel
        for channel in repository.list_channels(db, statuses=("active", "provisioning"))
        if _visible(channel, actor)
    ]
    memberships = repository.memberships_for_user(db, actor.id)
    counts = repository.joined_counts(db, [channel.id for channel in channels])
    return [
        to_read(channel, memberships.get(channel.id), counts.get(channel.id, 0), actor)
        for channel in channels
    ]


def get_channel(db: Session, actor: User, channel_id: UUID, matrix: MatrixClient) -> ChannelRead:
    channel = _load_visible(db, channel_id, actor)
    reconcile_membership(db, matrix, channel)
    return _read_one(db, channel, actor)


def list_members(
    db: Session, actor: User, channel_id: UUID, matrix: MatrixClient
) -> list[ChannelMemberRead]:
    channel = _load_visible(db, channel_id, actor)
    membership = repository.get_membership(db, channel.id, actor.id)
    if not is_app_admin(actor) and not _active(membership):
        raise _forbidden("Join the community to see its members")
    reconcile_membership(db, matrix, channel)
    rows = repository.list_members(db, channel.id)
    order = {"owner": 0, "admin": 1, "member": 2}
    active = [row for row in rows if row.status in ACTIVE_MEMBER_STATUSES]
    active.sort(key=lambda row: (order.get(row.role, 3), row.created_at))
    return [_member_read(row) for row in active]


# --------------------------------------------------------------------------- creation


def create_channel(
    db: Session, actor: User, payload: ChannelCreate, matrix: MatrixClient
) -> ChannelRead:
    """Any active user creates a community and becomes its owner."""
    if not actor.is_active:
        raise _forbidden("Inactive accounts cannot create communities")

    channel: Channel | None = None
    if payload.request_id:
        existing = repository.get_channel_by_creation_key(db, payload.request_id)
        if existing is not None:
            if existing.creator_id != actor.id:
                # Another account's key: never reveal or reuse it.
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="This creation request was already used",
                )
            if existing.matrix_room_id or existing.status != "provisioning":
                # Duplicate click or retry after success: same community, no second room.
                return _read_one(db, existing, actor)
            channel = existing  # earlier attempt never got a room: resume provisioning
    if channel is None:
        channel = Channel(
            name=payload.name,
            description=payload.description,
            category=payload.category,
            avatar_url=payload.avatar_url,
            creator_id=actor.id,
            creation_key=payload.request_id,
            status="provisioning",
        )
        db.add(channel)
    try:
        db.commit()
    except IntegrityError:
        # The same request_id was reserved concurrently: continue with that row instead.
        db.rollback()
        winner = repository.get_channel_by_creation_key(db, payload.request_id) if payload.request_id else None
        if winner is None or winner.creator_id != actor.id:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="The community could not be created",
            ) from None
        channel = winner
    channel_id = channel.id

    # Hold the row lock while provisioning: a concurrent request with the same key blocks here
    # until the first one finished, then finds the room recorded and returns it instead of
    # creating a second room (or resumes provisioning if the first attempt failed).
    channel = repository.get_channel(db, channel_id, for_update=True)
    if channel is None:
        raise _not_found()
    if channel.matrix_room_id:
        db.rollback()
        return _read_one(db, channel, actor)

    with _matrix_errors("create_room"):
        room_id = matrix.create_channel_room(
            channel_id=str(channel.id),
            name=channel.name,
            topic=channel.description,
            category=channel.category,
            avatar_url=channel.avatar_url,
        )
    channel.matrix_room_id = room_id
    channel.status = "active"
    try:
        db.commit()
    except SQLAlchemyError:
        db.rollback()
        try:
            matrix.leave_room(room_id)
        except MatrixConnectionError:
            logger.error("community_orphan_room room_id=%s channel_id=%s", room_id, channel.id)
        raise
    db.refresh(channel)
    logger.info("community_created channel_id=%s room_id=%s by=%s", channel.id, room_id, actor.id)

    # The creator joins as owner. A failure here leaves a valid community the owner can join
    # afterwards (the owner row is recorded on that join), so it is reported but not fatal.
    try:
        with _matrix_errors("join_creator"):
            _join_member(db, matrix, channel, actor, role="owner")
    except HTTPException as exc:
        logger.warning("community_owner_join_failed channel_id=%s detail=%s", channel.id, exc.detail)
    return _read_one(db, channel, actor)


# --------------------------------------------------------------------------- membership


def _role_for(channel: Channel, user: User, membership: ChannelMember | None) -> str:
    if channel.creator_id == user.id:
        return "owner"
    if is_app_admin(user):
        return "admin"
    if membership is not None and membership.role in PUBLISHER_ROLES:
        return membership.role
    return "member"


def _join_member(
    db: Session, matrix: MatrixClient, channel: Channel, user: User, *, role: str
) -> ChannelMember:
    """Make ``user`` a member of the community room with the power level of ``role``."""
    if not channel.matrix_room_id:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="The community is still being provisioned",
        )
    room_id = channel.matrix_room_id
    membership = repository.get_membership(db, channel.id, user.id)
    if membership is not None and membership.status == "joined" and membership.role == role:
        return membership

    mxid = matrix_user_id_for(user.id)
    current = matrix.room_membership(room_id, mxid)
    if current == "ban":
        matrix.unban_user(room_id, mxid)
    matrix.set_user_power_level(
        room_id, mxid, CHANNEL_PUBLISHER_POWER_LEVEL if role in PUBLISHER_ROLES else None
    )
    joined = current == "join"
    if not joined:
        joined = matrix.force_join(room_id, mxid)
        if not joined and current != "invite":
            matrix.invite_user(room_id, mxid)

    now = datetime.now(UTC)
    if membership is None:
        membership = ChannelMember(channel_id=channel.id, user_id=user.id)
        db.add(membership)
    membership.role = role
    membership.status = "joined" if joined else "invited"
    membership.joined_at = now if joined else None
    try:
        db.commit()
    except IntegrityError:
        # A concurrent join for the same pair won the race; the row it wrote is correct.
        db.rollback()
        existing = repository.get_membership(db, channel.id, user.id)
        if existing is None:
            raise
        return existing
    db.refresh(membership)
    return membership


def subscribe(db: Session, actor: User, channel_id: UUID, matrix: MatrixClient) -> ChannelRead:
    """Join a community (idempotent)."""
    channel = _load_visible(db, channel_id, actor, for_update=True)
    if channel.status != "active":
        raise _not_found()
    membership = repository.get_membership(db, channel.id, actor.id)
    role = _role_for(channel, actor, membership)
    with _matrix_errors("join"):
        _join_member(db, matrix, channel, actor, role=role)
    reconcile_membership(db, matrix, channel)
    return _read_one(db, channel, actor)


def unsubscribe(db: Session, actor: User, channel_id: UUID, matrix: MatrixClient) -> ChannelRead:
    """Leave a community (idempotent). Owners archive instead of leaving."""
    channel = _load_visible(db, channel_id, actor, for_update=True)
    membership = repository.get_membership(db, channel.id, actor.id)
    if _active(membership) and membership.role == "owner":
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Owners cannot leave their community; archive it instead",
        )
    if _active(membership) and channel.matrix_room_id:
        with _matrix_errors("leave"):
            matrix.kick_user(channel.matrix_room_id, matrix_user_id_for(actor.id), "Left the community")
        membership.status = "left"
        membership.joined_at = None
        db.commit()
    else:
        db.rollback()
    return _read_one(db, channel, actor)


def set_member_role(
    db: Session,
    actor: User,
    channel_id: UUID,
    user_id: UUID,
    payload: ChannelMemberRoleUpdate,
    matrix: MatrixClient,
) -> ChannelMemberRead:
    channel = _load_visible(db, channel_id, actor, for_update=True)
    actor_membership = repository.get_membership(db, channel.id, actor.id)
    if not can_edit(actor, actor_membership):
        db.rollback()
        raise _forbidden("Only the community owner can change member roles")
    target = repository.get_membership(db, channel.id, user_id)
    if target is None or target.status not in ACTIVE_MEMBER_STATUSES:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Member not found")
    if target.role == "owner":
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="The owner's role cannot be changed",
        )
    if payload.role == "member" and is_app_admin(target.user):
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Application administrators always hold admin rights",
        )
    if target.role != payload.role and channel.matrix_room_id:
        with _matrix_errors("set_role"):
            matrix.set_user_power_level(
                channel.matrix_room_id,
                matrix_user_id_for(target.user_id),
                CHANNEL_PUBLISHER_POWER_LEVEL if payload.role == "admin" else None,
            )
        target.role = payload.role
        db.commit()
    else:
        db.rollback()
    rows = {row.user_id: row for row in repository.list_members(db, channel.id)}
    return _member_read(rows[user_id])


def remove_member(
    db: Session, actor: User, channel_id: UUID, user_id: UUID, matrix: MatrixClient
) -> None:
    channel = _load_visible(db, channel_id, actor, for_update=True)
    actor_membership = repository.get_membership(db, channel.id, actor.id)
    if not can_manage(actor, actor_membership):
        db.rollback()
        raise _forbidden("Only community admins can remove members")
    if user_id == actor.id:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Leave the community instead of removing yourself",
        )
    target = repository.get_membership(db, channel.id, user_id)
    if target is None or target.status not in ACTIVE_MEMBER_STATUSES:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Member not found")
    if target.role == "owner":
        db.rollback()
        raise _forbidden("The community owner cannot be removed")
    # Admins moderate ordinary members only; owners and application admins moderate admins too.
    if (target.role == "admin" or is_app_admin(target.user)) and not can_edit(actor, actor_membership):
        db.rollback()
        raise _forbidden("Only the community owner can remove admins")
    if channel.matrix_room_id:
        mxid = matrix_user_id_for(target.user_id)
        with _matrix_errors("remove_member"):
            matrix.set_user_power_level(channel.matrix_room_id, mxid, None)
            matrix.kick_user(channel.matrix_room_id, mxid, "Removed by a community admin")
    target.status = "removed"
    target.role = "member"
    target.joined_at = None
    db.commit()


# --------------------------------------------------------------------------- updates


def update_channel(
    db: Session, actor: User, channel_id: UUID, payload: ChannelUpdate, matrix: MatrixClient
) -> ChannelRead:
    channel = _load_visible(db, channel_id, actor, for_update=True)
    membership = repository.get_membership(db, channel.id, actor.id)
    if not can_edit(actor, membership):
        db.rollback()
        raise _forbidden("Only the community owner can edit this community")
    updates = payload.model_dump(exclude_unset=True)
    room_id = channel.matrix_room_id
    if room_id:
        with _matrix_errors("update_room"):
            if "name" in updates:
                matrix.set_room_state(room_id, "m.room.name", {"name": updates["name"]})
            if "description" in updates:
                matrix.set_room_state(room_id, "m.room.topic", {"topic": updates["description"]})
            if "avatar_url" in updates:
                matrix.set_room_state(
                    room_id, "m.room.avatar", {"url": updates["avatar_url"]} if updates["avatar_url"] else {}
                )
            if "category" in updates:
                matrix.set_room_state(
                    room_id,
                    CHANNEL_MARKER_EVENT_TYPE,
                    {
                        "version": CHANNEL_MARKER_VERSION,
                        "channel_id": str(channel.id),
                        "category": updates["category"],
                    },
                )
    for key, value in updates.items():
        setattr(channel, key, value)
    db.commit()
    db.refresh(channel)
    return _read_one(db, channel, actor)


def archive_channel(db: Session, actor: User, channel_id: UUID, matrix: MatrixClient) -> None:
    channel = repository.get_channel(db, channel_id, for_update=True)
    if channel is None:
        raise _not_found()
    membership = repository.get_membership(db, channel.id, actor.id)
    if not can_edit(actor, membership):
        db.rollback()
        raise _forbidden("Only the community owner can archive it")
    if channel.status == "archived":
        db.rollback()
        return
    rows = repository.list_members(db, channel.id)
    if channel.matrix_room_id:
        for row in rows:
            if row.status not in ACTIVE_MEMBER_STATUSES:
                continue
            try:
                matrix.kick_user(channel.matrix_room_id, matrix_user_id_for(row.user_id), "Community archived")
            except MatrixConnectionError as exc:
                # Reconciliation on later reads converges stragglers; the archive still proceeds.
                logger.warning("community_archive_kick_failed channel_id=%s user=%s error=%s", channel.id, row.user_id, exc)
                continue
            row.status = "removed"
            row.joined_at = None
    channel.status = "archived"
    db.commit()
    logger.info("community_archived channel_id=%s by=%s", channel.id, actor.id)


# --------------------------------------------------------------------------- reconciliation


def reconcile_membership(db: Session, matrix: MatrixClient, channel: Channel) -> None:
    """Align membership rows with the room's actual joined members (best effort)."""
    if not channel.matrix_room_id or channel.status != "active":
        return
    try:
        joined = matrix.joined_members(channel.matrix_room_id)
    except MatrixConnectionError as exc:
        logger.warning("community_reconcile_skipped channel_id=%s error=%s", channel.id, exc)
        return
    joined.discard(matrix.service_user_id)
    rows = repository.list_members(db, channel.id)
    now = datetime.now(UTC)
    changed = False
    known: set[str] = set()
    for row in rows:
        mxid = matrix_user_id_for(row.user_id)
        known.add(mxid)
        if mxid in joined:
            if row.status != "joined":
                row.status = "joined"
                row.joined_at = row.joined_at or now
                changed = True
        elif row.status == "joined":
            row.status = "left"
            row.joined_at = None
            changed = True
    for mxid in joined - known:
        app_user_id = app_user_id_for(mxid)
        if app_user_id is None:
            logger.warning("community_foreign_member channel_id=%s user=%s", channel.id, mxid)
            continue
        user = db.get(User, app_user_id)
        if user is None:
            continue
        db.add(
            ChannelMember(
                channel_id=channel.id,
                user_id=user.id,
                role=_role_for(channel, user, None),
                status="joined",
                joined_at=now,
            )
        )
        changed = True
    if changed:
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
    else:
        db.rollback()
