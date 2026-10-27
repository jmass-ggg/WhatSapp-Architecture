from __future__ import annotations

from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, HttpUrl, model_validator


class ProfileRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    user_id: UUID
    display_name: str
    profile_picture_url: str | None
    bio: str | None
    job_title: str | None
    department: str | None
    organization: str | None


class ProfilePatch(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    display_name: str | None = Field(default=None, min_length=1, max_length=80)
    profile_picture_url: HttpUrl | None = None
    bio: str | None = Field(default=None, max_length=500)
    job_title: str | None = Field(default=None, max_length=120)
    department: str | None = Field(default=None, max_length=120)
    organization: str | None = Field(default=None, max_length=160)

    @model_validator(mode="after")
    def validate_patch(self) -> ProfilePatch:
        if not self.model_fields_set:
            raise ValueError("At least one profile field must be supplied")
        if "display_name" in self.model_fields_set and self.display_name is None:
            raise ValueError("Display name cannot be cleared")
        return self
