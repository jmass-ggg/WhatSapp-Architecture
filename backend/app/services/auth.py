from __future__ import annotations

import secrets
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from app.core.config import settings
from app.core.security import (
    create_access_token,
    create_refresh_token,
    hash_password,
    hash_refresh_token,
    password_needs_rehash,
    verify_password,
)
from app.models.profile import Profile
from app.models.refresh_token import RefreshToken
from app.models.subscription import Subscription
from app.models.user import User
from app.repositories import refresh_tokens, users
from app.schemas.auth import RegisterRequest


_DUMMY_PASSWORD_HASH = hash_password(secrets.token_urlsafe(32))
def _invalid_login() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid login credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )


def register_user(db: Session, payload: RegisterRequest) -> User:
    email = str(payload.email).casefold()
    username = payload.username.casefold()
    if users.get_by_email_or_username(db, email=email, username=username) is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Account could not be created with the supplied details",
        )

    user = User(
        email=email,
        username=username,
        password_hash=hash_password(payload.password.get_secret_value()),
        is_active=True,
        is_email_verified=False,
        role="user",
    )
    profile = Profile(
        user=user,
        display_name=payload.display_name or username,
    )
    free_subscription = Subscription(
        user=user,
        plan_id="free",
        status="active",
        starts_at=datetime.now(UTC),
    )
    db.add_all((user, profile, free_subscription))
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Account could not be created with the supplied details",
        ) from None
    db.refresh(user)
    return user


def authenticate_user(db: Session, login: str, password: str) -> User:
    user = users.get_by_login(db, login)
    stored_hash = user.password_hash if user is not None else _DUMMY_PASSWORD_HASH
    verified = verify_password(password, stored_hash)
    if user is None or not verified or not user.is_active:
        raise _invalid_login()
    if password_needs_rehash(user.password_hash):
        user.password_hash = hash_password(password)
        db.commit()
    return user


def issue_session(db: Session, user: User) -> tuple[str, str]:
    refresh_value = create_refresh_token()
    refresh_record = RefreshToken(
        user_id=user.id,
        token_hash=hash_refresh_token(refresh_value),
        family_id=uuid4(),
        expires_at=datetime.now(UTC) + timedelta(seconds=settings.app_refresh_token_ttl_seconds),
    )
    db.add(refresh_record)
    db.commit()
    return create_access_token(user.id), refresh_value


def _revoke_family(db: Session, family_id: UUID, now: datetime) -> None:
    family = db.scalars(
        select(RefreshToken).where(RefreshToken.family_id == family_id).with_for_update()
    )
    for token_record in family:
        if token_record.revoked_at is None:
            token_record.revoked_at = now


def rotate_refresh_token(db: Session, raw_token: str) -> tuple[User, str, str]:
    now = datetime.now(UTC)
    token_record = refresh_tokens.get_for_update(db, hash_refresh_token(raw_token))
    if token_record is None:
        raise _invalid_login()

    if token_record.revoked_at is not None:
        _revoke_family(db, token_record.family_id, now)
        db.commit()
        raise _invalid_login()

    user = db.get(User, token_record.user_id)
    if token_record.expires_at <= now or user is None or not user.is_active:
        _revoke_family(db, token_record.family_id, now)
        db.commit()
        raise _invalid_login()

    replacement_value = create_refresh_token()
    replacement = RefreshToken(
        id=uuid4(),
        user_id=user.id,
        token_hash=hash_refresh_token(replacement_value),
        family_id=token_record.family_id,
        expires_at=now + timedelta(seconds=settings.app_refresh_token_ttl_seconds),
    )
    db.add(replacement)
    db.flush()
    token_record.revoked_at = now
    token_record.replaced_by_id = replacement.id
    db.commit()
    return user, create_access_token(user.id, now), replacement_value


def revoke_refresh_token(db: Session, raw_token: str | None) -> None:
    if not raw_token:
        return
    now = datetime.now(UTC)
    token_record = refresh_tokens.get_for_update(db, hash_refresh_token(raw_token))
    if token_record is None:
        return
    _revoke_family(db, token_record.family_id, now)
    db.commit()


def get_authenticated_user(db: Session, user_id: UUID) -> User | None:
    statement = select(User).options(selectinload(User.profile)).where(User.id == user_id)
    return db.scalar(statement)
