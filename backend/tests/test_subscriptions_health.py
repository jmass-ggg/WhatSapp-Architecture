from __future__ import annotations

from datetime import UTC, datetime, timedelta

import httpx
import pytest
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.v1.health import get_matrix_client
from app.core.config import settings
from app.integrations.matrix.client import MatrixClient
from app.schemas.subscription import SubscriptionGrantRequest
from app.models.subscription import Subscription
from app.models.user import User
from tests.http_client import ApiClient


def auth_headers(client: ApiClient, user: User, password: str) -> dict[str, str]:
    response = client.post(
        "/api/v1/auth/login",
        json={"login": user.username, "password": password},
    )
    assert response.status_code == 200
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


def test_health_and_database_readiness(client: ApiClient) -> None:
    assert client.get("/health").json() == {"status": "ok"}
    assert client.get("/api/v1/health").json() == {"status": "ok"}
    ready = client.get("/api/v1/health/ready")
    assert ready.status_code == 200
    assert ready.json() == {"status": "ready", "database": "ok"}


def test_subscription_expiration_and_unknown_features(
    client: ApiClient,
    db_session: Session,
    user_factory,
) -> None:
    user = user_factory(username="expired_member")
    subscription = db_session.scalar(
        select(Subscription)
        .where(Subscription.user_id == user.id)
        .order_by(Subscription.created_at.desc())
    )
    subscription.plan_id = "pro"
    subscription.starts_at = datetime.now(UTC) - timedelta(days=30)
    subscription.expires_at = datetime.now(UTC) - timedelta(days=1)
    db_session.commit()
    headers = auth_headers(client, user, "Correct horse battery staple 17")

    access = client.get(
        "/api/v1/access/check?feature=profile.extended",
        headers=headers,
    )
    unknown = client.get(
        "/api/v1/access/check?feature=not.configured",
        headers=headers,
    )
    details = client.get("/api/v1/subscriptions/me", headers=headers)
    assert access.status_code == 200
    assert access.json() == {
        "feature": "profile.extended",
        "allowed": False,
        "effective_plan": "free",
        "reason": "subscription_expired",
    }
    assert unknown.json()["allowed"] is False
    assert unknown.json()["reason"] == "unknown_feature"
    assert details.json()["status"] == "expired"


@pytest.mark.parametrize(
    "dates",
    [
        {"starts_at": datetime(2026, 1, 1)},
        {
            "starts_at": datetime(2026, 1, 1, tzinfo=UTC),
            "expires_at": datetime(2026, 2, 1),
        },
    ],
    ids=("naive-start", "naive-expiration"),
)
def test_subscription_dates_require_timezones(dates: dict[str, datetime]) -> None:
    with pytest.raises(ValidationError):
        SubscriptionGrantRequest(plan_id="pro", **dates)


def test_subscription_write_requires_admin_and_records_actor(
    client: ApiClient,
    db_session: Session,
    user_factory,
) -> None:
    member = user_factory(username="regular_member")
    admin = user_factory(
        username="policy_admin",
        role="admin",
        password="Correct horse battery staple 17",
    )
    member_headers = auth_headers(client, member, "Correct horse battery staple 17")
    path = f"/api/v1/subscriptions/{member.id}"
    payload = {
        "plan_id": "pro",
        "status": "active",
        "starts_at": datetime.now(UTC).isoformat(),
        "expires_at": (datetime.now(UTC) + timedelta(days=30)).isoformat(),
    }

    denied = client.put(path, headers=member_headers, json=payload)
    assert denied.status_code == 403

    admin_headers = auth_headers(client, admin, "Correct horse battery staple 17")
    granted = client.put(path, headers=admin_headers, json=payload)
    assert granted.status_code == 201
    assert granted.json()["plan_id"] == "pro"
    created = db_session.get(Subscription, granted.json()["id"])
    assert created.created_by_user_id == admin.id


def test_matrix_health_client_uses_versions_endpoint(client: ApiClient) -> None:
    transport = httpx.MockTransport(
        lambda request: httpx.Response(200, json={"versions": ["v1.15"]})
    )
    matrix_client = MatrixClient("http://matrix.invalid", transport=transport)
    client.app.dependency_overrides[get_matrix_client] = lambda: matrix_client

    response = client.get("/api/v1/health/synapse")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "supported_versions": 1}


def test_matrix_failure_is_separate_from_database_readiness(client: ApiClient) -> None:
    transport = httpx.MockTransport(
        lambda request: httpx.Response(502, json={"error": "unavailable"})
    )
    client.app.dependency_overrides[get_matrix_client] = lambda: MatrixClient(
        "http://matrix.invalid",
        transport=transport,
    )

    synapse = client.get("/api/v1/health/synapse")
    ready = client.get("/api/v1/health/ready")
    assert synapse.status_code == 503
    assert synapse.json() == {"status": "unavailable"}
    assert ready.status_code == 200


def test_cors_is_limited_to_configured_frontend_origin(client: ApiClient) -> None:
    allowed = client.options(
        "/api/v1/auth/login",
        headers={
            "Origin": "http://localhost:5173",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
        },
    )
    denied = client.options(
        "/api/v1/auth/login",
        headers={
            "Origin": "https://untrusted.example",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
        },
    )
    assert allowed.headers["access-control-allow-origin"] == "http://localhost:5173"
    assert "access-control-allow-origin" not in denied.headers
