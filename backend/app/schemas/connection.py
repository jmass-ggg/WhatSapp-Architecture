from __future__ import annotations

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict

from app.schemas.profile import ProfileRead


ConnectionStatus = Literal["pending", "accepted", "declined", "blocked"]


class ConnectionRequestCreate(BaseModel):
    recipient_id: UUID


class ConnectionUserRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    username: str
    profile: ProfileRead | None


class UserConnectionRead(BaseModel):
    id: UUID
    requester_id: UUID
    recipient_id: UUID
    status: ConnectionStatus
    created_at: datetime
    updated_at: datetime
    accepted_at: datetime | None
    other_user: ConnectionUserRead
