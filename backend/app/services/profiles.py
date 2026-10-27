from __future__ import annotations

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.profile import Profile
from app.models.user import User
from app.repositories.profiles import get_for_user
from app.schemas.profile import ProfilePatch


def get_profile(db: Session, user: User) -> Profile:
    profile = get_for_user(db, user.id)
    if profile is None:
        raise HTTPException(status_code=404, detail="Profile not found")
    return profile


def update_profile(db: Session, user: User, payload: ProfilePatch) -> Profile:
    profile = get_profile(db, user)
    updates = payload.model_dump(exclude_unset=True)
    if not updates:
        raise HTTPException(status_code=422, detail="At least one profile field is required")
    for field, value in updates.items():
        if field == "profile_picture_url" and value is not None:
            value = str(value)
        setattr(profile, field, value)
    db.commit()
    db.refresh(profile)
    return profile
