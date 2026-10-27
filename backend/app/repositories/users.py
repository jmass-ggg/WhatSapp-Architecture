from __future__ import annotations

from uuid import UUID

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session, selectinload

from app.models.user import User


def get_by_id(db: Session, user_id: UUID) -> User | None:
    return db.get(User, user_id)


def get_by_login(db: Session, login: str) -> User | None:
    normalized = login.casefold()
    statement = (
        select(User)
        .options(selectinload(User.profile))
        .where(
            or_(
                func.lower(User.email) == normalized,
                func.lower(User.username) == normalized,
            )
        )
    )
    return db.scalar(statement)


def get_by_email_or_username(
    db: Session,
    *,
    email: str | None = None,
    username: str | None = None,
):
    filters = []
    if email is not None:
        filters.append(func.lower(User.email) == email.casefold())
    if username is not None:
        filters.append(func.lower(User.username) == username.casefold())
    if not filters:
        return None
    return db.scalar(select(User.id).where(or_(*filters)).limit(1))
