from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote

import httpx

from app.core.config import settings
from app.core.security import create_synapse_service_login_token


logger = logging.getLogger("app.matrix")


class MatrixConnectionError(RuntimeError):
    pass


class MatrixRequestError(MatrixConnectionError):
    """Synapse answered with an error status; ``errcode`` is the Matrix error code if any."""

    def __init__(self, message: str, status_code: int, errcode: str | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.errcode = errcode


#: Room type recorded in ``m.room.create`` of every channel room. The create event is part of
#: the stripped state Synapse sends with invites, so clients can classify channel rooms before
#: joining. It is a hint only: the backend's channel table is the source of truth.
CHANNEL_ROOM_TYPE = "org.recruitable.chat.channel"
#: State event that carries the backend channel ID inside the room.
CHANNEL_MARKER_EVENT_TYPE = "org.recruitable.chat.channel"
CHANNEL_MARKER_VERSION = 1

#: Power level required to publish announcements (channel admins and application admins).
CHANNEL_PUBLISHER_POWER_LEVEL = 50
#: Power level held by the service identity (room administration only).
CHANNEL_SERVICE_POWER_LEVEL = 100


def channel_power_levels() -> dict[str, Any]:
    """Power levels for a broadcast channel room.

    Subscribers (level 0) can only react and redact their own events. Publishing any
    ``m.room.message`` needs level 50. Every state change, invite, kick and ban needs level
    100, which only the service identity holds. The ``users`` map is intentionally absent:
    the room creator (the service identity) already holds the top level in every room
    version, and room versions 12+ reject creators listed in ``users``.
    """
    return {
        "users_default": 0,
        "events_default": CHANNEL_PUBLISHER_POWER_LEVEL,
        "state_default": CHANNEL_SERVICE_POWER_LEVEL,
        "ban": CHANNEL_SERVICE_POWER_LEVEL,
        "kick": CHANNEL_SERVICE_POWER_LEVEL,
        "invite": CHANNEL_SERVICE_POWER_LEVEL,
        "redact": CHANNEL_PUBLISHER_POWER_LEVEL,
        "historical": CHANNEL_SERVICE_POWER_LEVEL,
        "events": {
            "m.room.message": CHANNEL_PUBLISHER_POWER_LEVEL,
            "m.sticker": CHANNEL_PUBLISHER_POWER_LEVEL,
            "m.reaction": 0,
            "m.room.redaction": 0,
            "m.room.pinned_events": CHANNEL_PUBLISHER_POWER_LEVEL,
            "m.room.name": CHANNEL_SERVICE_POWER_LEVEL,
            "m.room.topic": CHANNEL_SERVICE_POWER_LEVEL,
            "m.room.avatar": CHANNEL_SERVICE_POWER_LEVEL,
            "m.room.canonical_alias": CHANNEL_SERVICE_POWER_LEVEL,
            "m.room.power_levels": CHANNEL_SERVICE_POWER_LEVEL,
            "m.room.join_rules": CHANNEL_SERVICE_POWER_LEVEL,
            "m.room.history_visibility": CHANNEL_SERVICE_POWER_LEVEL,
            "m.room.encryption": CHANNEL_SERVICE_POWER_LEVEL,
            "m.room.tombstone": CHANNEL_SERVICE_POWER_LEVEL,
            "m.room.server_acl": CHANNEL_SERVICE_POWER_LEVEL,
            CHANNEL_MARKER_EVENT_TYPE: CHANNEL_SERVICE_POWER_LEVEL,
        },
        "notifications": {"room": CHANNEL_PUBLISHER_POWER_LEVEL},
    }


@dataclass(frozen=True, slots=True)
class MatrixSession:
    access_token: str
    user_id: str
    device_id: str
    home_server: str | None = None
    expires_in_ms: int | None = None


class MatrixClient:
    def __init__(
        self,
        base_url: str | None = None,
        timeout: float | None = None,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self.base_url = (base_url or settings.synapse_internal_url).rstrip("/")
        self.timeout = timeout or settings.synapse_request_timeout_seconds
        self.transport = transport

    def versions(self) -> dict[str, Any]:
        try:
            with httpx.Client(timeout=self.timeout, transport=self.transport) as client:
                response = client.get(f"{self.base_url}/_matrix/client/versions")
                response.raise_for_status()
                payload = response.json()
        except (httpx.RequestError, httpx.HTTPStatusError, ValueError) as exc:
            raise MatrixConnectionError(
                "Synapse versions endpoint is unavailable"
            ) from exc

        if not isinstance(payload, dict) or not isinstance(payload.get("versions"), list):
            raise MatrixConnectionError("Synapse returned an invalid versions response")
        return payload

    def login_with_jwt(self, login_token: str, expected_user_id: str) -> MatrixSession:
        try:
            with httpx.Client(timeout=self.timeout, transport=self.transport) as client:
                response = client.post(
                    f"{self.base_url}/_matrix/client/v3/login",
                    json={
                        "type": "org.matrix.login.jwt",
                        "token": login_token,
                        "initial_device_display_name": "Realtime Chat",
                    },
                )
                response.raise_for_status()
                payload = response.json()
        except (httpx.RequestError, httpx.HTTPStatusError, ValueError) as exc:
            raise MatrixConnectionError(
                "Synapse authentication is unavailable"
            ) from exc

        if not isinstance(payload, dict):
            raise MatrixConnectionError("Synapse returned an invalid login response")

        access_token = payload.get("access_token")
        user_id = payload.get("user_id")
        device_id = payload.get("device_id")
        home_server = payload.get("home_server")
        expires_in_ms = payload.get("expires_in_ms")
        if (
            not isinstance(access_token, str)
            or not access_token
            or not isinstance(user_id, str)
            or user_id != expected_user_id
            or not isinstance(device_id, str)
            or not device_id
            or (home_server is not None and not isinstance(home_server, str))
            or (
                expires_in_ms is not None
                and (
                    not isinstance(expires_in_ms, int)
                    or isinstance(expires_in_ms, bool)
                )
            )
        ):
            raise MatrixConnectionError("Synapse returned an invalid login response")

        return MatrixSession(
            access_token=access_token,
            user_id=user_id,
            device_id=device_id,
            home_server=home_server,
            expires_in_ms=expires_in_ms,
        )

    def session_is_valid(self, session: MatrixSession) -> bool:
        try:
            with httpx.Client(timeout=self.timeout, transport=self.transport) as client:
                response = client.get(
                    f"{self.base_url}/_matrix/client/v3/account/whoami",
                    headers={"Authorization": f"Bearer {session.access_token}"},
                )
                if response.status_code in (401, 403):
                    return False
                response.raise_for_status()
                payload = response.json()
        except (httpx.RequestError, httpx.HTTPStatusError, ValueError) as exc:
            raise MatrixConnectionError("Synapse session validation is unavailable") from exc
        return (
            isinstance(payload, dict)
            and payload.get("user_id") == session.user_id
            and payload.get("device_id") == session.device_id
        )

    def logout(self, access_token: str) -> None:
        try:
            with httpx.Client(timeout=self.timeout, transport=self.transport) as client:
                response = client.post(
                    f"{self.base_url}/_matrix/client/v3/logout",
                    headers={"Authorization": f"Bearer {access_token}"},
                )
                response.raise_for_status()
        except (httpx.RequestError, httpx.HTTPStatusError) as exc:
            raise MatrixConnectionError("Synapse logout is unavailable") from exc

    def health(self) -> dict[str, int | str]:
        payload = self.versions()
        return {"status": "ok", "supported_versions": len(payload["versions"])}

    # ------------------------------------------------------------------ service identity

    # One cached service session per process, shared by every MatrixClient instance.
    _service_lock = threading.Lock()
    _service_session: MatrixSession | None = None
    _service_is_admin: bool | None = None
    _rate_limit_max_wait_ms = 3000

    @property
    def service_user_id(self) -> str:
        return f"@{settings.synapse_channels_service_localpart}:{settings.synapse_server_name}"

    def _login_service(self) -> MatrixSession:
        token, expected_user_id = create_synapse_service_login_token(
            settings.synapse_channels_service_localpart
        )
        session = self.login_with_jwt(token, expected_user_id)
        logger.info("matrix_service_login user_id=%s", session.user_id)
        return session

    def service_session(self, *, refresh: bool = False) -> MatrixSession:
        """The backend-only Matrix session used for channel provisioning (never sent to clients)."""
        cls = type(self)
        with cls._service_lock:
            if refresh or cls._service_session is None:
                cls._service_session = self._login_service()
                cls._service_is_admin = None
            return cls._service_session

    @classmethod
    def reset_service_session(cls) -> None:
        with cls._service_lock:
            cls._service_session = None
            cls._service_is_admin = None

    def _service_request(
        self,
        method: str,
        path: str,
        *,
        json: Any | None = None,
        params: dict[str, Any] | None = None,
        _retry: bool = True,
        _rate_limit_retries: int = 2,
    ) -> Any:
        session = self.service_session()
        try:
            with httpx.Client(timeout=self.timeout, transport=self.transport) as client:
                response = client.request(
                    method,
                    f"{self.base_url}{path}",
                    json=json,
                    params=params,
                    headers={"Authorization": f"Bearer {session.access_token}"},
                )
        except httpx.RequestError as exc:
            raise MatrixConnectionError("Synapse is unavailable") from exc

        if response.status_code == 401 and _retry:
            # Expired or revoked service token: log in again exactly once.
            self.service_session(refresh=True)
            return self._service_request(method, path, json=json, params=params, _retry=False)
        if response.status_code == 429 and _rate_limit_retries > 0:
            # Synapse rate limit (one service identity provisions every room): wait as told, briefly.
            retry_after_ms = 1000
            try:
                body = response.json()
                if isinstance(body, dict) and isinstance(body.get("retry_after_ms"), int):
                    retry_after_ms = body["retry_after_ms"]
            except ValueError:
                pass
            time.sleep(min(max(retry_after_ms, 100), self._rate_limit_max_wait_ms) / 1000)
            return self._service_request(
                method, path, json=json, params=params, _retry=_retry, _rate_limit_retries=_rate_limit_retries - 1
            )

        if response.status_code >= 400:
            errcode: str | None = None
            message = f"Synapse request failed with status {response.status_code}"
            try:
                body = response.json()
                if isinstance(body, dict):
                    errcode = body.get("errcode") if isinstance(body.get("errcode"), str) else None
                    if isinstance(body.get("error"), str):
                        message = body["error"]
            except ValueError:
                pass
            raise MatrixRequestError(message, response.status_code, errcode)
        if response.status_code == 204 or not response.content:
            return {}
        try:
            return response.json()
        except ValueError as exc:
            raise MatrixConnectionError("Synapse returned an invalid response") from exc

    # ------------------------------------------------------------------ channel rooms

    def create_channel_room(
        self,
        *,
        channel_id: str,
        name: str,
        topic: str,
        category: str,
        avatar_url: str | None,
    ) -> str:
        """Create an invite-only broadcast room owned by the service identity."""
        initial_state: list[dict[str, Any]] = [
            {"type": "m.room.join_rules", "state_key": "", "content": {"join_rule": "invite"}},
            {
                "type": "m.room.history_visibility",
                "state_key": "",
                "content": {"history_visibility": "shared"},
            },
            {"type": "m.room.guest_access", "state_key": "", "content": {"guest_access": "forbidden"}},
            {
                "type": CHANNEL_MARKER_EVENT_TYPE,
                "state_key": "",
                "content": {
                    "version": CHANNEL_MARKER_VERSION,
                    "channel_id": channel_id,
                    "category": category,
                },
            },
        ]
        if avatar_url:
            initial_state.append({"type": "m.room.avatar", "state_key": "", "content": {"url": avatar_url}})
        payload: dict[str, Any] = {
            "visibility": "private",
            "preset": "private_chat",
            "name": name,
            "creation_content": {"type": CHANNEL_ROOM_TYPE},
            "initial_state": initial_state,
            "power_level_content_override": channel_power_levels(),
        }
        if topic:
            payload["topic"] = topic
        response = self._service_request("POST", "/_matrix/client/v3/createRoom", json=payload)
        room_id = response.get("room_id") if isinstance(response, dict) else None
        if not isinstance(room_id, str) or not room_id.startswith("!"):
            raise MatrixConnectionError("Synapse returned an invalid createRoom response")
        return room_id

    def room_membership(self, room_id: str, user_id: str) -> str | None:
        try:
            content = self._service_request(
                "GET",
                f"/_matrix/client/v3/rooms/{quote(room_id, safe='')}/state/m.room.member/{quote(user_id, safe='')}",
            )
        except MatrixRequestError as exc:
            if exc.status_code == 404:
                return None
            raise
        membership = content.get("membership") if isinstance(content, dict) else None
        return membership if isinstance(membership, str) else None

    def invite_user(self, room_id: str, user_id: str) -> None:
        try:
            self._service_request(
                "POST",
                f"/_matrix/client/v3/rooms/{quote(room_id, safe='')}/invite",
                json={"user_id": user_id},
            )
        except MatrixRequestError as exc:
            # Synapse answers 403 when the user is already invited or joined; treat as done.
            if exc.status_code == 403 and "already in the room" in str(exc):
                return
            raise

    def unban_user(self, room_id: str, user_id: str) -> None:
        self._service_request(
            "POST",
            f"/_matrix/client/v3/rooms/{quote(room_id, safe='')}/unban",
            json={"user_id": user_id},
        )

    def kick_user(self, room_id: str, user_id: str, reason: str) -> None:
        try:
            self._service_request(
                "POST",
                f"/_matrix/client/v3/rooms/{quote(room_id, safe='')}/kick",
                json={"user_id": user_id, "reason": reason},
            )
        except MatrixRequestError as exc:
            # Not in the room (already left): nothing to do.
            if exc.status_code == 403 and "not in the room" in str(exc).lower():
                return
            raise

    def force_join(self, room_id: str, user_id: str) -> bool:
        """Join a local user through the Synapse admin API.

        Returns False when the service identity is not a server admin, in which case the
        caller falls back to the invite the user accepts from their own client.
        """
        cls = type(self)
        if cls._service_is_admin is False:
            return False
        try:
            self._service_request(
                "POST",
                f"/_synapse/admin/v1/join/{quote(room_id, safe='')}",
                json={"user_id": user_id},
            )
        except MatrixRequestError as exc:
            if exc.status_code == 403 and "server admin" in str(exc).lower():
                cls._service_is_admin = False
                logger.warning("matrix_service_not_admin fallback=invite")
                return False
            raise
        cls._service_is_admin = True
        return True

    def joined_members(self, room_id: str) -> set[str]:
        response = self._service_request(
            "GET", f"/_matrix/client/v3/rooms/{quote(room_id, safe='')}/joined_members"
        )
        joined = response.get("joined") if isinstance(response, dict) else None
        return set(joined.keys()) if isinstance(joined, dict) else set()

    def set_user_power_level(self, room_id: str, user_id: str, level: int | None) -> None:
        """Set (or clear, with ``None``) one user's power level, preserving everything else."""
        path = f"/_matrix/client/v3/rooms/{quote(room_id, safe='')}/state/m.room.power_levels/"
        current = self._service_request("GET", path)
        if not isinstance(current, dict):
            raise MatrixConnectionError("Synapse returned invalid power levels")
        users = dict(current.get("users") or {})
        if users.get(user_id) == level or (level is None and user_id not in users):
            return
        if level is None:
            users.pop(user_id, None)
        else:
            users[user_id] = level
        self._service_request("PUT", path, json={**current, "users": users})

    def set_room_state(self, room_id: str, event_type: str, content: dict[str, Any]) -> None:
        self._service_request(
            "PUT",
            f"/_matrix/client/v3/rooms/{quote(room_id, safe='')}/state/{quote(event_type, safe='')}/",
            json=content,
        )

    def leave_room(self, room_id: str) -> None:
        self._service_request("POST", f"/_matrix/client/v3/rooms/{quote(room_id, safe='')}/leave")
