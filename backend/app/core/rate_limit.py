from __future__ import annotations

from collections import defaultdict
from threading import Lock
from time import monotonic

from fastapi import HTTPException, Request, status

from app.core.config import settings


class FixedWindowRateLimiter:
    def __init__(self) -> None:
        self._lock = Lock()
        self._windows: dict[str, tuple[float, int]] = defaultdict(lambda: (0.0, 0))

    def check(self, key: str) -> int:
        now = monotonic()
        with self._lock:
            started_at, count = self._windows[key]
            if now - started_at >= settings.app_login_rate_limit_window_seconds:
                started_at, count = now, 0
            count += 1
            self._windows[key] = (started_at, count)
            if count > settings.app_login_rate_limit_attempts:
                retry_after = max(
                    1,
                    int(settings.app_login_rate_limit_window_seconds - (now - started_at)),
                )
                raise HTTPException(
                    status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                    detail="Too many login attempts",
                    headers={"Retry-After": str(retry_after)},
                )
        return count

    def clear(self) -> None:
        with self._lock:
            self._windows.clear()


login_rate_limiter = FixedWindowRateLimiter()


def limit_login(request: Request) -> None:
    client_host = request.client.host if request.client else "unknown"
    login_rate_limiter.check(client_host)
