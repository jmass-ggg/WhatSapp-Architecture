from __future__ import annotations

from uuid import UUID

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from app.models.user import User
from app.schemas.user import UserPatch


def can_view_user(viewer: User, subject: User) -> bool:
    return viewer.id == subject.id or viewer.role == "admin"


def get_visible_user(db: Session, viewer: User, subject_id: UUID) -> User:
    subject = db.scalar(
        select(User)
        .options(selectinload(User.profile))
        .where(User.id == subject_id, User.is_active.is_(True))
    )
    if subject is None or not can_view_user(viewer, subject):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    return subject


def update_user(db: Session, user: User, payload: UserPatch) -> User:
    updates = payload.model_dump(exclude_unset=True)
    if not updates:
        raise HTTPException(status_code=422, detail="At least one account field is required")

    if "email" in updates:
        updates["email"] = str(updates["email"]).casefold()
        if updates["email"] != user.email:
            user.is_email_verified = False
    if "username" in updates:
        updates["username"] = updates["username"].casefold()

    for field, value in updates.items():
        setattr(user, field, value)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Account could not be updated with the supplied details",
        ) from None
    db.refresh(user)
    return user


def search_users(
    db: Session,
    viewer: User,
    *,
    query: str | None,
    limit: int,
    offset: int,
) -> tuple[list[User], int]:
    statement = (
        select(User)
        .outerjoin(User.profile)
        .options(selectinload(User.profile))
        .where(User.is_active.is_(True), User.id != viewer.id)
    )
    count_statement = (
        select(func.count(User.id))
        .outerjoin(User.profile)
        .where(User.is_active.is_(True), User.id != viewer.id)
    )

    if query:
        escaped = (
            query.casefold()
            .replace("\\", "\\\\")
            .replace("%", "\\%")
            .replace("_", "\\_")
        )
        pattern = f"{escaped}%"
        search_filter = func.lower(User.username).like(pattern, escape="\\")
        statement = statement.where(search_filter)
        count_statement = count_statement.where(search_filter)

    total = db.scalar(count_statement) or 0
    users = list(
        db.scalars(
            statement.order_by(func.lower(User.username), User.id)
            .offset(offset)
            .limit(limit)
        ).all()
    )
    return users, total
