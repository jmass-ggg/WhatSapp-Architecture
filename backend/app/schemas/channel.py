from __future__ import annotations

import re
from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.schemas.profile import ProfileRead


ChannelCategory = Literal[
    "general", "announcements", "engineering", "technology", "finance", "gaming", "education", "hr", "product"
]
ChannelStatus = Literal["provisioning", "active", "archived"]
ChannelMemberRole = Literal["owner", "admin", "member"]
#: Roles an owner may assign; ownership itself never changes hands through this API.
AssignableRole = Literal["admin", "member"]
ChannelMemberStatus = Literal["invited", "joined", "left", "removed"]

_MXC_PATTERN = re.compile(r"^mxc://[A-Za-z0-9.\-]+(?::\d+)?/[A-Za-z0-9_\-]+$")
_NAME_PATTERN = re.compile(r"^[^\x00-\x1f\x7f]+$")


def _validate_avatar(value: str | None) -> str | None:
    if value is None:
        return None
    if not _MXC_PATTERN.match(value):
        raise ValueError("Channel avatars must be Matrix media (mxc://) URIs")
    return value


class ChannelCreate(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    name: str = Field(min_length=2, max_length=80)
    description: str = Field(default="", max_length=500)
    category: ChannelCategory = "general"
    avatar_url: str | None = Field(default=None, max_length=2048)
    #: Client-generated idempotency key (UUID recommended); retries with it never duplicate.
    request_id: str | None = Field(default=None, min_length=8, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")

    @field_validator("name")
    @classmethod
    def validate_name(cls, value: str) -> str:
        collapsed = " ".join(value.split())
        if len(collapsed) < 2 or not _NAME_PATTERN.match(collapsed):
            raise ValueError("Community names must be at least two printable characters")
        return collapsed

    @field_validator("avatar_url")
    @classmethod
    def validate_avatar(cls, value: str | None) -> str | None:
        return _validate_avatar(value)


class ChannelUpdate(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    name: str | None = Field(default=None, min_length=2, max_length=80)
    description: str | None = Field(default=None, max_length=500)
    category: ChannelCategory | None = None
    avatar_url: str | None = Field(default=None, max_length=2048)

    @field_validator("name")
    @classmethod
    def validate_name(cls, value: str | None) -> str | None:
        if value is None:
            return None
        collapsed = " ".join(value.split())
        if len(collapsed) < 2 or not _NAME_PATTERN.match(collapsed):
            raise ValueError("Channel names must be at least two printable characters")
        return collapsed

    @field_validator("avatar_url")
    @classmethod
    def validate_avatar(cls, value: str | None) -> str | None:
        return _validate_avatar(value)

    @model_validator(mode="after")
    def validate_patch(self) -> ChannelUpdate:
        if not self.model_fields_set:
            raise ValueError("At least one channel field must be supplied")
        if "name" in self.model_fields_set and self.name is None:
            raise ValueError("Channel name cannot be cleared")
        return self


class ChannelMembershipRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    role: ChannelMemberRole
    status: ChannelMemberStatus
    joined_at: datetime | None


class ChannelRead(BaseModel):
    id: UUID
    matrix_room_id: str | None
    name: str
    description: str
    avatar_url: str | None
    category: ChannelCategory
    creator_id: UUID | None
    is_verified: bool
    status: ChannelStatus
    created_at: datetime
    updated_at: datetime
    #: Members whose Matrix membership is currently joined.
    member_count: int
    #: The caller's own membership row, if they ever joined.
    membership: ChannelMembershipRead | None
    #: Caller may moderate members (owner, community admin or application admin).
    can_manage: bool
    #: Caller may edit the community, assign admins and archive it (owner or application admin).
    can_edit: bool
    #: Caller holds publishing rights inside the room (owner, admin or application admin).
    can_publish: bool


class ChannelMemberUserRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    username: str
    profile: ProfileRead | None


class ChannelMemberRead(BaseModel):
    user: ChannelMemberUserRead
    matrix_user_id: str
    role: ChannelMemberRole
    status: ChannelMemberStatus
    joined_at: datetime | None


class ChannelMemberRoleUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    role: AssignableRole
