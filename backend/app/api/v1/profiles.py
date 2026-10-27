from __future__ import annotations

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.dependencies import CurrentUser
from app.core.database import get_db
from app.models.profile import Profile
from app.schemas.profile import ProfilePatch, ProfileRead
from app.services.profiles import get_profile, update_profile
from app.services.users import get_visible_user


router = APIRouter(prefix="/profiles", tags=["profiles"])


@router.get("/{user_id}", response_model=ProfileRead)
def read_profile(
    user_id: UUID,
    current_user: CurrentUser,
    db: Annotated[Session, Depends(get_db)],
) -> Profile:
    subject = get_visible_user(db, current_user, user_id)
    return get_profile(db, subject)


@router.patch("/me", response_model=ProfileRead)
def patch_profile(
    payload: ProfilePatch,
    current_user: CurrentUser,
    db: Annotated[Session, Depends(get_db)],
) -> Profile:
    return update_profile(db, current_user, payload)
