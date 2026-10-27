from __future__ import annotations

from datetime import UTC, datetime
from uuid import UUID

from fastapi import HTTPException, status
from sqlalchemy import and_, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from app.models.user import User
from app.models.user_connection import UserConnection
from app.schemas.connection import ConnectionRequestCreate, UserConnectionRead


def _connection_read(connection: UserConnection, viewer_id: UUID) -> UserConnectionRead:
    other_user = (
        connection.recipient
        if connection.requester_id == viewer_id
        else connection.requester
    )
    return UserConnectionRead(
        id=connection.id,
        requester_id=connection.requester_id,
        recipient_id=connection.recipient_id,
        status=connection.status,
        created_at=connection.created_at,
        updated_at=connection.updated_at,
        accepted_at=connection.accepted_at,
        other_user=other_user,
    )


def create_connection_request(
    db: Session,
    requester: User,
    payload: ConnectionRequestCreate,
) -> UserConnectionRead:
    if payload.recipient_id == requester.id:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="You cannot send a connection request to yourself",
        )

    recipient = db.scalar(
        select(User)
        .options(selectinload(User.profile))
        .where(User.id == payload.recipient_id, User.is_active.is_(True))
    )
    if recipient is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")

    existing = db.scalar(
        select(UserConnection)
        .where(
            or_(
                and_(
                    UserConnection.requester_id == requester.id,
                    UserConnection.recipient_id == recipient.id,
                ),
                and_(
                    UserConnection.requester_id == recipient.id,
                    UserConnection.recipient_id == requester.id,
                ),
            )
        )
        .with_for_update()
    )
    now = datetime.now(UTC)
    if existing is not None:
        if existing.status != "declined":
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="A connection request or connection already exists",
            )
        existing.requester_id = requester.id
        existing.recipient_id = recipient.id
        existing.status = "pending"
        existing.created_at = now
        existing.updated_at = now
        existing.accepted_at = None
        connection = existing
    else:
        connection = UserConnection(
            requester_id=requester.id,
            recipient_id=recipient.id,
            status="pending",
            created_at=now,
            updated_at=now,
        )
        db.add(connection)

    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="A connection request or connection already exists",
        ) from None

    db.refresh(connection)
    return _connection_read(connection, requester.id)


def _load_connection(db: Session, connection_id: UUID) -> UserConnection:
    connection = db.scalar(
        select(UserConnection)
        .options(
            selectinload(UserConnection.requester).selectinload(User.profile),
            selectinload(UserConnection.recipient).selectinload(User.profile),
        )
        .where(UserConnection.id == connection_id)
        .with_for_update()
    )
    if connection is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Connection not found")
    return connection


def _require_recipient_pending(
    connection: UserConnection,
    recipient_id: UUID,
) -> None:
    if connection.recipient_id != recipient_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the request recipient may respond",
        )
    if connection.status != "pending":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Connection request is no longer pending",
        )


def accept_connection_request(
    db: Session,
    connection_id: UUID,
    recipient_id: UUID,
) -> UserConnectionRead:
    connection = _load_connection(db, connection_id)
    _require_recipient_pending(connection, recipient_id)
    now = datetime.now(UTC)
    connection.status = "accepted"
    connection.updated_at = now
    connection.accepted_at = now
    db.commit()
    db.refresh(connection)
    return _connection_read(connection, recipient_id)


def decline_connection_request(
    db: Session,
    connection_id: UUID,
    recipient_id: UUID,
) -> UserConnectionRead:
    connection = _load_connection(db, connection_id)
    _require_recipient_pending(connection, recipient_id)
    connection.status = "declined"
    connection.updated_at = datetime.now(UTC)
    connection.accepted_at = None
    db.commit()
    db.refresh(connection)
    return _connection_read(connection, recipient_id)


def list_incoming_requests(db: Session, recipient_id: UUID) -> list[UserConnectionRead]:
    connections = db.scalars(
        select(UserConnection)
        .options(
            selectinload(UserConnection.requester).selectinload(User.profile),
            selectinload(UserConnection.recipient).selectinload(User.profile),
        )
        .where(
            UserConnection.recipient_id == recipient_id,
            UserConnection.status == "pending",
        )
        .order_by(UserConnection.created_at.desc(), UserConnection.id)
    ).all()
    return [_connection_read(connection, recipient_id) for connection in connections]


def list_outgoing_requests(db: Session, requester_id: UUID) -> list[UserConnectionRead]:
    connections = db.scalars(
        select(UserConnection)
        .options(
            selectinload(UserConnection.requester).selectinload(User.profile),
            selectinload(UserConnection.recipient).selectinload(User.profile),
        )
        .where(
            UserConnection.requester_id == requester_id,
            UserConnection.status == "pending",
        )
        .order_by(UserConnection.created_at.desc(), UserConnection.id)
    ).all()
    return [_connection_read(connection, requester_id) for connection in connections]


def list_accepted_connections(db: Session, user_id: UUID) -> list[UserConnectionRead]:
    connections = db.scalars(
        select(UserConnection)
        .options(
            selectinload(UserConnection.requester).selectinload(User.profile),
            selectinload(UserConnection.recipient).selectinload(User.profile),
        )
        .where(
            or_(
                UserConnection.requester_id == user_id,
                UserConnection.recipient_id == user_id,
            ),
            UserConnection.status == "accepted",
        )
        .order_by(UserConnection.accepted_at.desc(), UserConnection.id)
    ).all()
    return [_connection_read(connection, user_id) for connection in connections]
