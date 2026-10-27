from __future__ import annotations

from app.models.user import User
from tests.http_client import ApiClient


def bearer(user: User, client: ApiClient) -> dict[str, str]:
    response = client.post(
        "/api/v1/auth/login",
        json={
            "login": user.username,
            "password": "Correct horse battery staple 17",
        },
    )
    assert response.status_code == 200
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


def test_connection_request_acceptance_is_private_and_persistent(
    client: ApiClient,
    user_factory,
) -> None:
    james = user_factory(username="james_user")
    kanye = user_factory(username="kanye_user")
    james_headers = bearer(james, client)
    kanye_headers = bearer(kanye, client)

    discovery = client.get(
        "/api/v1/users/search?q=KANYE",
        headers=james_headers,
    )
    assert discovery.status_code == 200
    assert [item["username"] for item in discovery.json()["items"]] == ["kanye_user"]
    assert "email" not in discovery.text
    assert "password_hash" not in discovery.text

    sent = client.post(
        "/api/v1/connections/requests",
        headers=james_headers,
        json={"recipient_id": str(kanye.id)},
    )
    assert sent.status_code == 201
    request = sent.json()
    assert request["status"] == "pending"
    assert request["other_user"]["username"] == "kanye_user"
    assert "email" not in sent.text
    assert "password_hash" not in sent.text

    incoming = client.get("/api/v1/connections/requests/incoming", headers=kanye_headers)
    outgoing = client.get("/api/v1/connections/requests/outgoing", headers=james_headers)
    assert [item["id"] for item in incoming.json()] == [request["id"]]
    assert [item["id"] for item in outgoing.json()] == [request["id"]]

    duplicate = client.post(
        "/api/v1/connections/requests",
        headers=james_headers,
        json={"recipient_id": str(kanye.id)},
    )
    reverse_duplicate = client.post(
        "/api/v1/connections/requests",
        headers=kanye_headers,
        json={"recipient_id": str(james.id)},
    )
    assert duplicate.status_code == reverse_duplicate.status_code == 409

    wrong_recipient = client.post(
        f"/api/v1/connections/{request['id']}/accept",
        headers=james_headers,
    )
    assert wrong_recipient.status_code == 403

    accepted = client.post(
        f"/api/v1/connections/{request['id']}/accept",
        headers=kanye_headers,
    )
    assert accepted.status_code == 200
    assert accepted.json()["status"] == "accepted"
    assert accepted.json()["accepted_at"] is not None

    assert client.get(
        "/api/v1/connections/requests/incoming",
        headers=kanye_headers,
    ).json() == []
    assert client.get(
        "/api/v1/connections/requests/outgoing",
        headers=james_headers,
    ).json() == []
    assert client.get("/api/v1/connections", headers=james_headers).json()[0][
        "other_user"
    ]["username"] == "kanye_user"
    assert client.get("/api/v1/connections", headers=kanye_headers).json()[0][
        "other_user"
    ]["username"] == "james_user"


def test_declined_requests_do_not_create_connections_and_may_be_resent(
    client: ApiClient,
    user_factory,
) -> None:
    james = user_factory(username="james_decline")
    kanye = user_factory(username="kanye_decline")
    james_headers = bearer(james, client)
    kanye_headers = bearer(kanye, client)

    sent = client.post(
        "/api/v1/connections/requests",
        headers=james_headers,
        json={"recipient_id": str(kanye.id)},
    )
    declined = client.post(
        f"/api/v1/connections/{sent.json()['id']}/decline",
        headers=kanye_headers,
    )
    assert declined.status_code == 200
    assert declined.json()["status"] == "declined"
    assert client.get("/api/v1/connections", headers=james_headers).json() == []

    resent = client.post(
        "/api/v1/connections/requests",
        headers=james_headers,
        json={"recipient_id": str(kanye.id)},
    )
    assert resent.status_code == 201
    assert resent.json()["id"] == sent.json()["id"]
    assert resent.json()["status"] == "pending"
    assert client.get("/api/v1/connections/requests/incoming", headers=kanye_headers).json()[
        0
    ]["id"] == sent.json()["id"]


def test_connection_requests_reject_self_and_unknown_recipients(
    client: ApiClient,
    user_factory,
) -> None:
    james = user_factory(username="james_validation")
    james_headers = bearer(james, client)

    self_request = client.post(
        "/api/v1/connections/requests",
        headers=james_headers,
        json={"recipient_id": str(james.id)},
    )
    missing_user = client.post(
        "/api/v1/connections/requests",
        headers=james_headers,
        json={"recipient_id": "00000000-0000-0000-0000-000000000000"},
    )
    assert self_request.status_code == 422
    assert missing_user.status_code == 404
