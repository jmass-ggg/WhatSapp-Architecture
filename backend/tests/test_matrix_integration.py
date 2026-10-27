from __future__ import annotations

import os
from uuid import uuid4

import httpx
import pytest

from app.api.dependencies import get_matrix_client
from app.core.config import settings
from app.integrations.matrix.client import MatrixClient, MatrixConnectionError
from tests.http_client import ApiClient


@pytest.mark.skipif(
    os.getenv("RUN_SYNAPSE_INTEGRATION") != "1",
    reason="requires a configured Synapse service on the backend network",
)
def test_two_app_users_authenticate_to_synapse_without_matrix_passwords(
    client: ApiClient,
) -> None:
    client.app.dependency_overrides.pop(get_matrix_client, None)
    suffix = uuid4().hex[:12]
    password_a = f"App-only password A {suffix}!"
    password_b = f"App-only password B {suffix}!"
    users = (
        (f"step05_a_{suffix}", password_a),
        (f"step05_b_{suffix}", password_b),
    )

    for username, password in users:
        registered = client.post(
            "/api/v1/auth/register",
            json={
                "email": f"{username}@example.com",
                "username": username,
                "password": password,
                "display_name": username,
            },
        )
        assert registered.status_code == 201, registered.text

    matrix_sessions: list[dict[str, str]] = []
    try:
        for username, password in users:
            response = client.post(
                "/api/v1/auth/login",
                json={"login": username, "password": password},
            )
            assert response.status_code == 200, response.text
            matrix_sessions.append(response.json()["matrix"])

        assert matrix_sessions[0]["user_id"] != matrix_sessions[1]["user_id"]
        assert matrix_sessions[0]["access_token"] != matrix_sessions[1]["access_token"]
        with httpx.Client(timeout=settings.synapse_request_timeout_seconds) as matrix:
            for session in matrix_sessions:
                whoami = matrix.get(
                    f"{settings.synapse_internal_url.rstrip('/')}/_matrix/client/v3/account/whoami",
                    headers={"Authorization": f"Bearer {session['access_token']}"},
                )
                assert whoami.status_code == 200
                assert whoami.json()["user_id"] == session["user_id"]
    finally:
        matrix_client = MatrixClient()
        for session in matrix_sessions:
            try:
                matrix_client.logout(session["access_token"])
            except MatrixConnectionError:
                # Keep cleanup best-effort; assertions above report auth failures.
                pass
