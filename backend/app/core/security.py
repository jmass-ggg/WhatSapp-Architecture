from __future__ import annotations

import hashlib
import secrets
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import jwt
from argon2 import PasswordHasher, Type
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError
from jwt import InvalidTokenError

from app.core.config import settings


_password_hasher = PasswordHasher(type=Type.ID)


def hash_password(password: str) -> str:
    return _password_hasher.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return _password_hasher.verify(password_hash, password)
    except (InvalidHashError, VerificationError, VerifyMismatchError):
        return False


def password_needs_rehash(password_hash: str) -> bool:
    try:
        return _password_hasher.check_needs_rehash(password_hash)
    except InvalidHashError:
        return True


def create_access_token(user_id: UUID, now: datetime | None = None) -> str:
    issued_at = now or datetime.now(UTC)
    expires_at = issued_at + timedelta(seconds=settings.app_jwt_ttl_seconds)
    payload = {
        "sub": str(user_id),
        "iss": settings.app_jwt_issuer,
        "aud": settings.app_jwt_audience,
        "iat": issued_at,
        "exp": expires_at,
        "jti": uuid4().hex,
        "token_use": "access",
    }
    return jwt.encode(
        payload,
        settings.app_jwt_signing_key.get_secret_value(),
        algorithm=settings.app_jwt_algorithm,
    )


def decode_access_token(token: str) -> UUID:
    payload = jwt.decode(
        token,
        settings.app_jwt_signing_key.get_secret_value(),
        algorithms=[settings.app_jwt_algorithm],
        issuer=settings.app_jwt_issuer,
        audience=settings.app_jwt_audience,
        options={
            "require": ["sub", "iss", "aud", "iat", "exp", "jti", "token_use"],
        },
    )
    if payload.get("token_use") != "access":
        raise InvalidTokenError("Wrong token purpose")
    return UUID(payload["sub"])


def create_refresh_token() -> str:
    return secrets.token_urlsafe(48)


def hash_refresh_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()
