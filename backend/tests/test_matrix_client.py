from __future__ import annotations

import json

import httpx
import pytest

from app.integrations.matrix.client import MatrixClient, MatrixConnectionError


def test_synapse_login_uses_the_server_side_jwt_flow() -> None:
    seen: list[httpx.Request] = []

    def respond(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(
            200,
            json={
                "access_token": "synapse-session-token",
                "user_id": "@u_0123456789abcdef:localhost",
                "device_id": "DEVICE123",
                "home_server": "localhost",
            },
        )

    client = MatrixClient(
        "http://synapse.invalid",
        transport=httpx.MockTransport(respond),
    )
    session = client.login_with_jwt(
        "short-lived-bridge-token",
        "@u_0123456789abcdef:localhost",
    )

    assert len(seen) == 1
    assert seen[0].method == "POST"
    assert seen[0].url.path == "/_matrix/client/v3/login"
    payload = json.loads(seen[0].content)
    assert payload == {
        "type": "org.matrix.login.jwt",
        "token": "short-lived-bridge-token",
        "initial_device_display_name": "Realtime Chat",
    }
    assert "password" not in payload
    assert session.access_token == "synapse-session-token"
    assert session.user_id == "@u_0123456789abcdef:localhost"
    assert session.device_id == "DEVICE123"


def test_synapse_login_rejects_a_response_for_another_user() -> None:
    transport = httpx.MockTransport(
        lambda request: httpx.Response(
            200,
            json={
                "access_token": "synapse-session-token",
                "user_id": "@someone-else:localhost",
                "device_id": "DEVICE123",
            },
        )
    )

    with pytest.raises(MatrixConnectionError, match="invalid login response"):
        MatrixClient("http://synapse.invalid", transport=transport).login_with_jwt(
            "short-lived-bridge-token",
            "@u_0123456789abcdef:localhost",
        )


def test_synapse_error_response_is_not_included_in_auth_error() -> None:
    bridge_token = "do-not-echo-this-bridge-token"
    transport = httpx.MockTransport(
        lambda request: httpx.Response(
            403,
            json={"errcode": "M_FORBIDDEN", "error": bridge_token},
        )
    )

    with pytest.raises(MatrixConnectionError) as error:
        MatrixClient("http://synapse.invalid", transport=transport).login_with_jwt(
            bridge_token,
            "@u_0123456789abcdef:localhost",
        )

    assert bridge_token not in str(error.value)


def test_synapse_logout_sends_the_matrix_token_only_as_bearer_auth() -> None:
    matrix_token = "matrix-session-token"
    seen: list[httpx.Request] = []

    def respond(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={})

    MatrixClient(
        "http://synapse.invalid",
        transport=httpx.MockTransport(respond),
    ).logout(matrix_token)

    assert len(seen) == 1
    assert seen[0].method == "POST"
    assert seen[0].url.path == "/_matrix/client/v3/logout"
    assert seen[0].headers["authorization"] == f"Bearer {matrix_token}"
    assert matrix_token not in str(seen[0].url)
