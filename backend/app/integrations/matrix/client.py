from __future__ import annotations

from typing import Any

import httpx

from app.core.config import settings


class MatrixConnectionError(RuntimeError):
    pass


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
            raise MatrixConnectionError("Synapse versions endpoint is unavailable") from exc

        if not isinstance(payload, dict) or not isinstance(payload.get("versions"), list):
            raise MatrixConnectionError("Synapse returned an invalid versions response")
        return payload

    def health(self) -> dict[str, int | str]:
        payload = self.versions()
        return {"status": "ok", "supported_versions": len(payload["versions"])}
