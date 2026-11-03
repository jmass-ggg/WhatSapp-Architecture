"""Real Synapse integration: community provisioning, joins and power-level enforcement.

Runs only with RUN_SYNAPSE_INTEGRATION=1 on the backend network (disposable local Synapse).
"""
from __future__ import annotations

import os
from uuid import uuid4

import httpx
import pytest

from app.api.dependencies import get_matrix_client
from app.core.config import settings
from app.integrations.matrix.client import MatrixClient, MatrixConnectionError
from tests.http_client import ApiClient


pytestmark = pytest.mark.skipif(
    os.getenv("RUN_SYNAPSE_INTEGRATION") != "1",
    reason="requires a configured Synapse service on the backend network",
)


def test_channel_roles_are_enforced_by_synapse(client: ApiClient, user_factory) -> None:
    client.app.dependency_overrides.pop(get_matrix_client, None)
    suffix = uuid4().hex[:10]
    admin = user_factory(username=f"chan_owner_{suffix}")
    alice = user_factory(username=f"chan_alice_{suffix}")
    bob = user_factory(username=f"chan_bob_{suffix}")
    synapse = settings.synapse_internal_url.rstrip("/")
    sessions: dict[str, dict[str, str]] = {}

    def login(user) -> dict[str, str]:
        response = client.post(
            "/api/v1/auth/login",
            json={"login": user.username, "password": "Correct horse battery staple 17"},
        )
        assert response.status_code == 200, response.text
        payload = response.json()
        sessions[user.username] = payload["matrix"]
        return {"Authorization": f"Bearer {payload['access_token']}"}

    try:
        admin_headers, alice_headers, bob_headers = login(admin), login(alice), login(bob)
        assert client.post("/api/v1/channels", json={"name": f"Nope {suffix}"}).status_code == 401

        created = client.post(
            "/api/v1/channels",
            headers=admin_headers,
            json={"name": f"Integration {suffix}", "description": "live", "category": "engineering"},
        )
        assert created.status_code == 201, created.text
        channel = created.json()
        room_id = channel["matrix_room_id"]
        assert room_id.startswith("!")

        with httpx.Client(timeout=settings.synapse_request_timeout_seconds) as matrix:
            def mx(user, method: str, path: str, **kwargs) -> httpx.Response:
                token = sessions[user.username]["access_token"]
                return matrix.request(method, f"{synapse}{path}", headers={"Authorization": f"Bearer {token}"}, **kwargs)

            def join_if_invited(user, headers) -> None:
                detail = client.get(f"/api/v1/channels/{channel['id']}", headers=headers).json()
                if detail["membership"]["status"] == "invited":
                    assert mx(user, "POST", f"/_matrix/client/v3/join/{room_id}", json={}).status_code == 200

            join_if_invited(admin, admin_headers)
            for user, headers in ((alice, alice_headers), (bob, bob_headers)):
                subscribed = client.post(f"/api/v1/channels/{channel['id']}/join", headers=headers)
                assert subscribed.status_code == 200, subscribed.text
                join_if_invited(user, headers)

            detail = client.get(f"/api/v1/channels/{channel['id']}", headers=alice_headers).json()
            assert detail["member_count"] == 3
            assert detail["membership"]["status"] == "joined"
            assert detail["can_publish"] is False

            create_event = mx(admin, "GET", f"/_matrix/client/v3/rooms/{room_id}/state/m.room.create").json()
            assert create_event["type"] == "org.recruitable.chat.channel"

            txn = uuid4().hex
            blocked = mx(alice, "PUT", f"/_matrix/client/v3/rooms/{room_id}/send/m.room.message/{txn}", json={"msgtype": "m.text", "body": "nope"})
            assert blocked.status_code == 403, blocked.text

            published = mx(admin, "PUT", f"/_matrix/client/v3/rooms/{room_id}/send/m.room.message/{uuid4().hex}", json={"msgtype": "m.text", "body": "hello subscribers"})
            assert published.status_code == 200, published.text
            event_id = published.json()["event_id"]

            reacted = mx(bob, "PUT", f"/_matrix/client/v3/rooms/{room_id}/send/m.reaction/{uuid4().hex}", json={"m.relates_to": {"rel_type": "m.annotation", "event_id": event_id, "key": "👍"}})
            assert reacted.status_code == 200, reacted.text

            no_invite = mx(alice, "POST", f"/_matrix/client/v3/rooms/{room_id}/invite", json={"user_id": "@u_nobody:localhost"})
            assert no_invite.status_code == 403

            promoted = client.put(f"/api/v1/channels/{channel['id']}/members/{alice.id}/role", headers=admin_headers, json={"role": "admin"})
            assert promoted.status_code == 200, promoted.text
            now_allowed = mx(alice, "PUT", f"/_matrix/client/v3/rooms/{room_id}/send/m.room.message/{uuid4().hex}", json={"msgtype": "m.text", "body": "promoted"})
            assert now_allowed.status_code == 200, now_allowed.text

            left = client.post(f"/api/v1/channels/{channel['id']}/leave", headers=bob_headers)
            assert left.status_code == 200 and left.json()["membership"]["status"] == "left"
            membership = mx(admin, "GET", f"/_matrix/client/v3/rooms/{room_id}/state/m.room.member/{sessions[bob.username]['user_id']}").json()
            assert membership["membership"] == "leave"

            assert client.delete(f"/api/v1/channels/{channel['id']}", headers=admin_headers).status_code == 204
    finally:
        matrix_client = MatrixClient()
        for session in sessions.values():
            try:
                matrix_client.logout(session["access_token"])
            except MatrixConnectionError:
                pass
