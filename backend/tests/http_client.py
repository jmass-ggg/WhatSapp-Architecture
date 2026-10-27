from __future__ import annotations

import asyncio
from types import TracebackType
from typing import Any

import httpx
from fastapi import FastAPI


class ApiClient:
    """Synchronous test facade over HTTPX's in-process ASGI transport."""

    def __init__(self, app: FastAPI) -> None:
        self.app = app
        self._loop = asyncio.new_event_loop()
        self._client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://testserver",
        )

    @property
    def cookies(self) -> httpx.Cookies:
        return self._client.cookies

    def _request(self, method: str, url: str, **kwargs: Any) -> httpx.Response:
        return self._loop.run_until_complete(self._client.request(method, url, **kwargs))

    def get(self, url: str, **kwargs: Any) -> httpx.Response:
        return self._request("GET", url, **kwargs)

    def post(self, url: str, **kwargs: Any) -> httpx.Response:
        return self._request("POST", url, **kwargs)

    def patch(self, url: str, **kwargs: Any) -> httpx.Response:
        return self._request("PATCH", url, **kwargs)

    def put(self, url: str, **kwargs: Any) -> httpx.Response:
        return self._request("PUT", url, **kwargs)

    def options(self, url: str, **kwargs: Any) -> httpx.Response:
        return self._request("OPTIONS", url, **kwargs)

    def close(self) -> None:
        self._loop.run_until_complete(self._client.aclose())
        self._loop.close()

    def __enter__(self) -> ApiClient:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        self.close()
