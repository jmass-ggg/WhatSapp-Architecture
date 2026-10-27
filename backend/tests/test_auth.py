from __future__ import annotations

from uuid import UUID

import jwt
import pytest

from app.core.config import settings
from app.core.rate_limit import login_rate_limiter
from app.core.security import decode_access_token, hash_password, verify_password
from app.models.refresh_token import RefreshToken
from app.models.user import User
from tests.http_client import ApiClient


def register(client: ApiClient, username: str = "alice_example") -> dict:
    response = client.post(
        "/api/v1/auth/register",
        json={
            "email": f"{username}@example.com",
            "username": username,
            "password": "A strong sample password 47",
            "display_name": "Alice Example",
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def login(client: ApiClient, username: str = "alice_example"):
    return client.post(
        "/api/v1/auth/login",
        json={
            "login": username,
            "password": "A strong sample password 47",
        },
    )


def test_registration_hashes_password_and_does_not_return_secrets(
    client: ApiClient,
    db_session,
) -> None:
    body = register(client)
    stored_user = db_session.query(User).filter_by(username="alice_example").one()

    assert body["username"] == "alice_example"
    assert body["is_email_verified"] is False
    assert stored_user.password_hash.startswith("$argon2id$")
    assert "password_hash" not in body
    assert "password" not in body
    assert "refresh_token" not in body


def test_duplicate_registration_uses_generic_conflict(client: ApiClient) -> None:
    register(client)
    duplicate_email = client.post(
        "/api/v1/auth/register",
        json={
            "email": "alice_example@example.com",
            "username": "different_name",
            "password": "A strong sample password 47",
        },
    )
    duplicate_username = client.post(
        "/api/v1/auth/register",
        json={
            "email": "different@example.com",
            "username": "alice_example",
            "password": "A strong sample password 47",
        },
    )
    assert duplicate_email.status_code == duplicate_username.status_code == 409
    assert duplicate_email.json()["detail"] == duplicate_username.json()["detail"]


def test_registration_can_be_disabled(client: ApiClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "app_registration_enabled", False)
    response = client.post(
        "/api/v1/auth/register",
        json={
            "email": "disabled@example.com",
            "username": "disabled_user",
            "password": "A strong sample password 47",
        },
    )
    assert response.status_code == 403


def test_login_issues_app_and_matrix_sessions_with_separate_jwts(
    client: ApiClient,
    matrix_client,
) -> None:
    register(client)
    response = login(client)

    assert response.status_code == 200
    body = response.json()
    app_token = body["access_token"]
    matrix_session = body["matrix"]
    assert UUID(str(decode_access_token(app_token)))
    assert body["token_type"] == "bearer"
    assert "refresh_token" not in body
    assert matrix_session["access_token"].startswith("matrix-")
    assert matrix_session["user_id"].startswith("@u_")
    assert matrix_session["device_id"]
    assert "password" not in body

    bridge_token, expected_user_id = matrix_client.login_requests[0]
    bridge_claims = jwt.decode(
        bridge_token,
        settings.synapse_jwt_signing_key.get_secret_value(),
        algorithms=[settings.synapse_jwt_algorithm],
        issuer=settings.synapse_jwt_issuer,
        audience=settings.synapse_jwt_audience,
    )
    assert bridge_token not in response.text
    assert settings.synapse_jwt_signing_key.get_secret_value() not in response.text
    assert bridge_claims["sub"] == matrix_session["user_id"].split(":", 1)[0][1:]
    assert (
        bridge_claims["exp"] - bridge_claims["iat"]
        == settings.synapse_jwt_ttl_seconds
    )
    assert expected_user_id == matrix_session["user_id"]
    assert bridge_claims["display_name"] == "Alice Example"
    assert "password" not in bridge_claims
    with pytest.raises(jwt.InvalidSignatureError):
        jwt.decode(
            bridge_token,
            settings.app_jwt_signing_key.get_secret_value(),
            algorithms=[settings.app_jwt_algorithm],
            options={"verify_exp": False, "verify_aud": False, "verify_iss": False},
        )
    with pytest.raises(jwt.InvalidSignatureError):
        jwt.decode(
            app_token,
            settings.synapse_jwt_signing_key.get_secret_value(),
            algorithms=[settings.synapse_jwt_algorithm],
            options={"verify_exp": False, "verify_aud": False, "verify_iss": False},
        )

    cookie = response.headers["set-cookie"].casefold()
    assert "httponly" in cookie
    assert "samesite=strict" in cookie
    assert client.cookies.get("app_refresh")


def test_two_app_users_get_distinct_synapse_sessions_without_matrix_passwords(
    client: ApiClient,
    matrix_client,
) -> None:
    register(client, "alice_example")
    register(client, "bob_example")

    alice = login(client, "alice_example")
    bob = login(client, "bob_example")

    assert alice.status_code == bob.status_code == 200
    alice_matrix = alice.json()["matrix"]
    bob_matrix = bob.json()["matrix"]
    assert alice_matrix["user_id"] != bob_matrix["user_id"]
    assert alice_matrix["access_token"] != bob_matrix["access_token"]
    assert len(matrix_client.login_requests) == 2

    alice_claims = jwt.decode(
        matrix_client.login_requests[0][0],
        settings.synapse_jwt_signing_key.get_secret_value(),
        algorithms=[settings.synapse_jwt_algorithm],
        issuer=settings.synapse_jwt_issuer,
        audience=settings.synapse_jwt_audience,
    )
    bob_claims = jwt.decode(
        matrix_client.login_requests[1][0],
        settings.synapse_jwt_signing_key.get_secret_value(),
        algorithms=[settings.synapse_jwt_algorithm],
        issuer=settings.synapse_jwt_issuer,
        audience=settings.synapse_jwt_audience,
    )
    assert alice_claims["sub"] != bob_claims["sub"]
    assert "password" not in alice_claims
    assert "password" not in bob_claims


def test_synapse_failure_does_not_issue_app_refresh_session(
    client: ApiClient,
    matrix_client,
    db_session,
) -> None:
    register(client)
    matrix_client.fail_login = True

    response = login(client)

    assert response.status_code == 503
    assert response.json() == {
        "detail": "Matrix authentication is temporarily unavailable"
    }
    assert client.cookies.get("app_refresh") is None
    assert db_session.query(RefreshToken).count() == 0


def test_invalid_login_is_generic_and_rate_limited_by_ip(
    client: ApiClient,
    matrix_client,
) -> None:
    register(client)
    wrong_password = client.post(
        "/api/v1/auth/login",
        json={"login": "alice_example", "password": "wrong password"},
    )
    unknown_user = client.post(
        "/api/v1/auth/login",
        json={"login": "unknown@example.com", "password": "wrong password"},
    )
    assert wrong_password.status_code == unknown_user.status_code == 401
    assert wrong_password.json() == unknown_user.json()

    login_rate_limiter.clear()
    assert matrix_client.login_requests == []
    monkeypatch_limit = settings.app_login_rate_limit_attempts
    try:
        settings.app_login_rate_limit_attempts = 1
        login(client)
        limited = login(client)
        assert limited.status_code == 429
        assert limited.headers["retry-after"]
    finally:
        settings.app_login_rate_limit_attempts = monkeypatch_limit
        login_rate_limiter.clear()


def test_access_token_rejects_wrong_issuer_and_audience(client: ApiClient) -> None:
    register(client)
    token = login(client).json()["access_token"]
    assert client.get(
        "/api/v1/auth/me",
        headers={"Authorization": f"Bearer {token}"},
    ).status_code == 200

    invalid = jwt.encode(
        {
            "sub": "00000000-0000-0000-0000-000000000001",
            "iss": "wrong-issuer",
            "aud": "wrong-audience",
            "iat": 1_900_000_000,
            "exp": 1_900_000_900,
            "jti": "invalid",
            "token_use": "access",
        },
        settings.app_jwt_signing_key.get_secret_value(),
        algorithm=settings.app_jwt_algorithm,
    )
    response = client.get(
        "/api/v1/auth/me",
        headers={"Authorization": f"Bearer {invalid}"},
    )
    assert response.status_code == 401


def test_refresh_rotates_token_and_reuse_revokes_the_family(client: ApiClient) -> None:
    register(client)
    assert login(client).status_code == 200
    old_refresh = client.cookies.get("app_refresh")
    assert old_refresh is not None

    rotated = client.post("/api/v1/auth/refresh")
    new_refresh = rotated.cookies.get("app_refresh")
    assert rotated.status_code == 200
    assert "matrix" not in rotated.json()
    assert new_refresh is not None and new_refresh != old_refresh

    with ApiClient(client.app) as replay_client:
        replay_client.cookies.set("app_refresh", old_refresh)
        replay = replay_client.post("/api/v1/auth/refresh")
        replay_client.cookies.set("app_refresh", new_refresh)
        after_reuse = replay_client.post("/api/v1/auth/refresh")
    assert replay.status_code == 401
    assert after_reuse.status_code == 401


def test_logout_revokes_app_and_matrix_sessions(
    client: ApiClient,
    matrix_client,
) -> None:
    register(client)
    session = login(client).json()["matrix"]
    refresh_value = client.cookies.get("app_refresh")
    assert refresh_value is not None
    logout = client.post(
        "/api/v1/auth/logout",
        json={"matrix_access_token": session["access_token"]},
    )
    with ApiClient(client.app) as refresh_client:
        refresh_client.cookies.set("app_refresh", refresh_value)
        refresh = refresh_client.post("/api/v1/auth/refresh")

    assert logout.status_code == 204
    assert refresh.status_code == 401
    assert matrix_client.logout_tokens == [session["access_token"]]


def test_app_logout_succeeds_when_synapse_is_unavailable(
    client: ApiClient,
    matrix_client,
) -> None:
    register(client)
    session = login(client).json()["matrix"]
    refresh_value = client.cookies.get("app_refresh")
    assert refresh_value is not None

    matrix_client.fail_logout = True
    logout = client.post(
        "/api/v1/auth/logout",
        json={"matrix_access_token": session["access_token"]},
    )
    with ApiClient(client.app) as refresh_client:
        refresh_client.cookies.set("app_refresh", refresh_value)
        refresh = refresh_client.post("/api/v1/auth/refresh")

    assert logout.status_code == 204
    assert refresh.status_code == 401


def test_password_hashing_uses_argon2id_and_verifies() -> None:
    password = "One good test password 958!"
    stored_hash = hash_password(password)
    assert stored_hash.startswith("$argon2id$")
    assert verify_password(password, stored_hash)
    assert not verify_password("not the same password", stored_hash)


def test_validation_errors_do_not_echo_submitted_password(client: ApiClient) -> None:
    password = "short"
    response = client.post(
        "/api/v1/auth/register",
        json={
            "email": "validation@example.com",
            "username": "validation_user",
            "password": password,
        },
    )
    assert response.status_code == 422
    assert password not in response.text
