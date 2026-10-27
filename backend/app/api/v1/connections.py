from __future__ import annotations

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.dependencies import CurrentUser
from app.core.database import get_db
from app.core.permissions import require_feature
from app.models.user import User
from app.schemas.connection import ConnectionRequestCreate, UserConnectionRead
from app.services.connections import (
    accept_connection_request,
    create_connection_request,
    decline_connection_request,
    list_accepted_connections,
    list_incoming_requests,
    list_outgoing_requests,
)


router = APIRouter(prefix="/connections", tags=["connections"])
DirectoryUser = Annotated[User, Depends(require_feature("directory.search"))]


@router.post("/requests", response_model=UserConnectionRead, status_code=201)
def send_connection_request(
    payload: ConnectionRequestCreate,
    current_user: DirectoryUser,
    db: Annotated[Session, Depends(get_db)],
) -> UserConnectionRead:
    return create_connection_request(db, current_user, payload)


@router.get("/requests/incoming", response_model=list[UserConnectionRead])
def read_incoming_requests(
    current_user: CurrentUser,
    db: Annotated[Session, Depends(get_db)],
) -> list[UserConnectionRead]:
    return list_incoming_requests(db, current_user.id)


@router.get("/requests/outgoing", response_model=list[UserConnectionRead])
def read_outgoing_requests(
    current_user: CurrentUser,
    db: Annotated[Session, Depends(get_db)],
) -> list[UserConnectionRead]:
    return list_outgoing_requests(db, current_user.id)


@router.post("/{connection_id}/accept", response_model=UserConnectionRead)
def accept_request(
    connection_id: UUID,
    current_user: CurrentUser,
    db: Annotated[Session, Depends(get_db)],
) -> UserConnectionRead:
    return accept_connection_request(db, connection_id, current_user.id)


@router.post("/{connection_id}/decline", response_model=UserConnectionRead)
def decline_request(
    connection_id: UUID,
    current_user: CurrentUser,
    db: Annotated[Session, Depends(get_db)],
) -> UserConnectionRead:
    return decline_connection_request(db, connection_id, current_user.id)


@router.get("", response_model=list[UserConnectionRead])
def read_connections(
    current_user: CurrentUser,
    db: Annotated[Session, Depends(get_db)],
) -> list[UserConnectionRead]:
    return list_accepted_connections(db, current_user.id)
