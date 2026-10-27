from __future__ import annotations

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, EmailStr, Field, model_validator

from app.schemas.profile import ProfileRead


class UserMeRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    email: EmailStr
    username: str
    is_active: bool
    is_email_verified: bool
    role: str
    created_at: datetime
    updated_at: datetime
    profile: ProfileRead


class UserDirectoryRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    username: str
    profile: ProfileRead


class UserPatch(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    email: EmailStr | None = None
    username: str | None = Field(
        default=None,
        min_length=3,
        max_length=32,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9_.-]*$",
    )

    @model_validator(mode="after")
    def validate_patch(self) -> UserPatch:
        if not self.model_fields_set:
            raise ValueError("At least one account field must be supplied")
        if any(getattr(self, field) is None for field in self.model_fields_set):
            raise ValueError("Account fields cannot be cleared")
        if self.email is not None:
            self.email = str(self.email).casefold()
        if self.username is not None:
            self.username = self.username.casefold()
        return self


class UserPage(BaseModel):
    items: list[UserDirectoryRead]
    limit: int
    offset: int
    total: int
