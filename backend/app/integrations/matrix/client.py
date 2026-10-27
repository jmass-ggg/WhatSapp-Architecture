from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import httpx

from app.core.config import settings


class MatrixConnectionError(RuntimeError):
    pass


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
