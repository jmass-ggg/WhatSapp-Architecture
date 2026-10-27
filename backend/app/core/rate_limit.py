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

    def check(
        self,
        key: str,
        *,
        attempts: int | None = None,
        window_seconds: int | None = None,
        detail: str = "Too many login attempts",
    ) -> int:
        max_attempts = attempts or settings.app_login_rate_limit_attempts
        window = window_seconds or settings.app_login_rate_limit_window_seconds
        now = monotonic()
        with self._lock:
            started_at, count = self._windows[key]
            if now - started_at >= window:
                started_at, count = now, 0
            count += 1
            self._windows[key] = (started_at, count)
            if count > max_attempts:
                retry_after = max(
                    1,
                    int(window - (now - started_at)),
                )
                raise HTTPException(
                    status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                    detail=detail,
                    headers={"Retry-After": str(retry_after)},
                )
        return count

    def clear(self) -> None:
        with self._lock:
            self._windows.clear()


login_rate_limiter = FixedWindowRateLimiter()
directory_search_rate_limiter = FixedWindowRateLimiter()


def limit_login(request: Request) -> None:
    client_host = request.client.host if request.client else "unknown"
    login_rate_limiter.check(client_host)


def limit_directory_search(user_id: str) -> None:
    directory_search_rate_limiter.check(
        f"directory:{user_id}",
        attempts=settings.app_directory_rate_limit_attempts,
        window_seconds=settings.app_directory_rate_limit_window_seconds,
        detail="Too many directory searches",
    )
