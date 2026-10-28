from __future__ import annotations

import base64
import hashlib
import json
from uuid import UUID

from cryptography.fernet import Fernet, InvalidToken

from app.core.config import settings
from app.integrations.matrix.client import MatrixSession


def _cipher() -> Fernet:
    secret = settings.app_jwt_signing_key.get_secret_value().encode()
    key = hashlib.sha256(b"recruitable-chat-matrix-cookie-v1\0" + secret).digest()
    return Fernet(base64.urlsafe_b64encode(key))


def encode_matrix_session(session: MatrixSession, user_id: UUID, family_id: UUID) -> str:
    payload = {
        "user": str(user_id),
        "family": str(family_id),
        "session": {
            "access_token": session.access_token,
            "user_id": session.user_id,
            "device_id": session.device_id,
            "home_server": session.home_server,
            "expires_in_ms": session.expires_in_ms,
        },
    }
    return _cipher().encrypt(json.dumps(payload, separators=(",", ":")).encode()).decode()


def decode_matrix_session(
    value: str | None, user_id: UUID, family_id: UUID,
) -> MatrixSession | None:
    if not value:
        return None
    try:
        raw = _cipher().decrypt(value.encode(), ttl=settings.app_refresh_token_ttl_seconds)
        payload = json.loads(raw)
        if payload["user"] != str(user_id) or payload["family"] != str(family_id):
            return None
        session = payload["session"]
        if not all(isinstance(session.get(key), str) and session[key]
                   for key in ("access_token", "user_id", "device_id")):
            return None
        return MatrixSession(**session)
    except (InvalidToken, ValueError, TypeError, KeyError, AttributeError):
        return None
