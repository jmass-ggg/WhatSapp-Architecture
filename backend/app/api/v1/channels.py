from __future__ import annotations

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Response, status
from sqlalchemy.orm import Session

from app.api.dependencies import CurrentUser, get_matrix_client
from app.core.database import get_db
from app.integrations.matrix.client import MatrixClient
from app.schemas.channel import (
    ChannelCreate,
    ChannelMemberRead,
    ChannelMemberRoleUpdate,
    ChannelRead,
    ChannelUpdate,
)
from app.services import channels as service


# Communities keep the original /channels path so existing clients and data stay valid.
router = APIRouter(prefix="/channels", tags=["communities"])
Matrix = Annotated[MatrixClient, Depends(get_matrix_client)]
Database = Annotated[Session, Depends(get_db)]


@router.get("", response_model=list[ChannelRead])
def read_channels(current_user: CurrentUser, db: Database) -> list[ChannelRead]:
    return service.list_channels(db, current_user)


@router.post("", response_model=ChannelRead, status_code=status.HTTP_201_CREATED)
def create_channel(
    payload: ChannelCreate, current_user: CurrentUser, db: Database, matrix: Matrix
) -> ChannelRead:
    """Any authenticated, active user may create a community and becomes its owner."""
    return service.create_channel(db, current_user, payload, matrix)


@router.get("/{channel_id}", response_model=ChannelRead)
def read_channel(
    channel_id: UUID, current_user: CurrentUser, db: Database, matrix: Matrix
) -> ChannelRead:
    return service.get_channel(db, current_user, channel_id, matrix)


@router.patch("/{channel_id}", response_model=ChannelRead)
def update_channel(
    channel_id: UUID,
    payload: ChannelUpdate,
    current_user: CurrentUser,
    db: Database,
    matrix: Matrix,
) -> ChannelRead:
    return service.update_channel(db, current_user, channel_id, payload, matrix)


@router.delete("/{channel_id}", status_code=status.HTTP_204_NO_CONTENT)
def archive_channel(
    channel_id: UUID, current_user: CurrentUser, db: Database, matrix: Matrix
) -> Response:
    service.archive_channel(db, current_user, channel_id, matrix)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/{channel_id}/join", response_model=ChannelRead)
@router.post("/{channel_id}/subscribe", response_model=ChannelRead, include_in_schema=False)
def join(
    channel_id: UUID, current_user: CurrentUser, db: Database, matrix: Matrix
) -> ChannelRead:
    return service.subscribe(db, current_user, channel_id, matrix)


@router.post("/{channel_id}/leave", response_model=ChannelRead)
@router.post("/{channel_id}/unsubscribe", response_model=ChannelRead, include_in_schema=False)
def leave(
    channel_id: UUID, current_user: CurrentUser, db: Database, matrix: Matrix
) -> ChannelRead:
    return service.unsubscribe(db, current_user, channel_id, matrix)


@router.get("/{channel_id}/members", response_model=list[ChannelMemberRead])
def read_members(
    channel_id: UUID, current_user: CurrentUser, db: Database, matrix: Matrix
) -> list[ChannelMemberRead]:
    return service.list_members(db, current_user, channel_id, matrix)


@router.put("/{channel_id}/members/{user_id}/role", response_model=ChannelMemberRead)
def set_member_role(
    channel_id: UUID,
    user_id: UUID,
    payload: ChannelMemberRoleUpdate,
    current_user: CurrentUser,
    db: Database,
    matrix: Matrix,
) -> ChannelMemberRead:
    return service.set_member_role(db, current_user, channel_id, user_id, payload, matrix)


@router.delete("/{channel_id}/members/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_member(
    channel_id: UUID, user_id: UUID, current_user: CurrentUser, db: Database, matrix: Matrix
) -> Response:
    service.remove_member(db, current_user, channel_id, user_id, matrix)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
