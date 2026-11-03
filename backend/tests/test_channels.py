from __future__ import annotations

from uuid import uuid4

from app.core.security import matrix_localpart
from app.core.config import settings
from app.integrations.matrix.client import (
    CHANNEL_PUBLISHER_POWER_LEVEL,
    CHANNEL_ROOM_TYPE,
    channel_power_levels,
)
from tests.conftest import FakeMatrixClient
from tests.http_client import ApiClient
from tests.test_connections import bearer


def mxid(user) -> str:
    return f"@{matrix_localpart(user.id)}:{settings.synapse_server_name}"


def create_community(client: ApiClient, headers, **overrides):
    payload = {"name": "Engineering Team", "description": "Sprint news", "category": "engineering"}
    payload.update(overrides)
    return client.post("/api/v1/channels", headers=headers, json=payload)


def test_power_levels_lock_the_room_down() -> None:
    levels = channel_power_levels()
    assert levels["users_default"] == 0
    assert levels["events_default"] == CHANNEL_PUBLISHER_POWER_LEVEL
    assert levels["events"]["m.room.message"] == CHANNEL_PUBLISHER_POWER_LEVEL
    assert levels["events"]["m.reaction"] == 0
    assert levels["events"]["m.room.redaction"] == 0
    assert levels["state_default"] == 100
    assert levels["invite"] == levels["kick"] == levels["ban"] == 100
    assert levels["events"]["m.room.power_levels"] == 100
    # Creators are never listed: room versions 12+ reject that, older ones already grant 100.
    assert "users" not in levels
    assert CHANNEL_ROOM_TYPE == "org.recruitable.chat.channel"


def test_any_user_creates_a_community_and_becomes_owner(client: ApiClient, user_factory, matrix_client: FakeMatrixClient) -> None:
    creator = user_factory(username="comm_creator")
    headers = bearer(creator, client)

    created = create_community(client, headers)
    assert created.status_code == 201, created.text
    body = created.json()
    assert body["status"] == "active"
    assert body["matrix_room_id"].startswith("!channel")
    assert body["member_count"] == 1
    assert body["membership"]["role"] == "owner"
    assert body["membership"]["status"] == "joined"
    assert body["can_manage"] is True and body["can_edit"] is True and body["can_publish"] is True
    assert body["is_verified"] is False

    room = matrix_client.rooms[body["matrix_room_id"]]
    assert room["members"][mxid(creator)] == "join"
    assert room["users"][mxid(creator)] == CHANNEL_PUBLISHER_POWER_LEVEL
    assert room["state"]["org.recruitable.chat.channel"]["channel_id"] == body["id"]

    # Every authenticated user sees it; names are not unique, IDs are.
    other = user_factory(username="comm_other")
    listed = client.get("/api/v1/channels", headers=bearer(other, client))
    assert [item["id"] for item in listed.json()] == [body["id"]]
    assert listed.json()[0]["membership"] is None
    assert listed.json()[0]["can_publish"] is False
    second = create_community(client, bearer(other, client))
    assert second.status_code == 201
    assert second.json()["id"] != body["id"]
    assert second.json()["name"] == body["name"]
    assert len({item["id"] for item in client.get("/api/v1/channels", headers=headers).json()}) == 2


def test_inactive_or_unauthenticated_users_cannot_create(client: ApiClient, user_factory, db_session) -> None:
    assert client.post("/api/v1/channels", json={"name": "X Y"}).status_code == 401
    assert client.get("/api/v1/channels").status_code == 401
    assert client.get(f"/api/v1/channels/{uuid4()}").status_code == 401


def test_duplicate_create_requests_are_idempotent(client: ApiClient, user_factory, matrix_client: FakeMatrixClient) -> None:
    creator = user_factory(username="dup_creator")
    headers = bearer(creator, client)
    key = uuid4().hex
    first = create_community(client, headers, request_id=key)
    second = create_community(client, headers, request_id=key, description="changed")
    assert first.status_code == 201 and second.status_code == 201
    assert first.json()["id"] == second.json()["id"]
    assert second.json()["description"] == "Sprint news"
    assert len(matrix_client.rooms) == 1

    # Another account cannot replay someone else's key.
    stranger = user_factory(username="dup_stranger")
    replay = create_community(client, bearer(stranger, client), request_id=key)
    assert replay.status_code == 409
    assert len(matrix_client.rooms) == 1


def test_failed_room_creation_leaves_no_visible_community_and_can_be_retried(
    client: ApiClient, user_factory, matrix_client: FakeMatrixClient
) -> None:
    creator = user_factory(username="retry_creator")
    headers = bearer(creator, client)
    other = user_factory(username="retry_other")
    key = uuid4().hex

    matrix_client.fail_create_room = True
    failed = create_community(client, headers, request_id=key)
    assert failed.status_code == 503
    assert client.get("/api/v1/channels", headers=bearer(other, client)).json() == []
    pending = client.get("/api/v1/channels", headers=headers).json()
    assert [item["status"] for item in pending] == ["provisioning"]

    matrix_client.fail_create_room = False
    retried = create_community(client, headers, request_id=key, description="Second attempt")
    assert retried.status_code == 201, retried.text
    assert retried.json()["id"] == pending[0]["id"]
    assert retried.json()["status"] == "active"
    assert len(matrix_client.rooms) == 1


def test_join_and_leave_keep_matrix_and_database_consistent(
    client: ApiClient, user_factory, matrix_client: FakeMatrixClient
) -> None:
    owner = user_factory(username="join_owner")
    alice = user_factory(username="join_alice")
    bob = user_factory(username="join_bob")
    owner_headers = bearer(owner, client)
    alice_headers = bearer(alice, client)
    bob_headers = bearer(bob, client)
    community = create_community(client, owner_headers).json()
    room = matrix_client.rooms[community["matrix_room_id"]]

    joined = client.post(f"/api/v1/channels/{community['id']}/join", headers=alice_headers)
    assert joined.status_code == 200, joined.text
    assert joined.json()["membership"] == {"role": "member", "status": "joined", "joined_at": joined.json()["membership"]["joined_at"]}
    assert joined.json()["can_publish"] is False and joined.json()["can_manage"] is False
    assert joined.json()["member_count"] == 2
    assert room["members"][mxid(alice)] == "join"
    assert mxid(alice) not in room["users"]  # default power level: cannot publish

    # Duplicate joins are idempotent and never create extra rows or Matrix calls.
    calls_before = len(matrix_client.calls)
    again = client.post(f"/api/v1/channels/{community['id']}/join", headers=alice_headers)
    assert again.status_code == 200 and again.json()["member_count"] == 2
    assert len(matrix_client.calls) == calls_before

    assert client.post(f"/api/v1/channels/{community['id']}/subscribe", headers=bob_headers).status_code == 200
    members = client.get(f"/api/v1/channels/{community['id']}/members", headers=alice_headers)
    assert members.status_code == 200
    assert [(m["user"]["username"], m["role"]) for m in members.json()] == [
        ("join_owner", "owner"), ("join_alice", "member"), ("join_bob", "member"),
    ]
    assert "email" not in members.text

    left = client.post(f"/api/v1/channels/{community['id']}/leave", headers=alice_headers)
    assert left.status_code == 200
    assert left.json()["membership"]["status"] == "left"
    assert left.json()["member_count"] == 2
    assert room["members"][mxid(alice)] == "leave"
    assert client.get(f"/api/v1/channels/{community['id']}/members", headers=alice_headers).status_code == 403

    back = client.post(f"/api/v1/channels/{community['id']}/join", headers=alice_headers)
    assert back.json()["membership"]["status"] == "joined"
    assert room["members"][mxid(alice)] == "join"

    # Owners archive rather than leave.
    assert client.post(f"/api/v1/channels/{community['id']}/leave", headers=owner_headers).status_code == 400
    assert room["members"][mxid(owner)] == "join"


def test_join_falls_back_to_invite_when_service_is_not_server_admin(
    client: ApiClient, user_factory, matrix_client: FakeMatrixClient
) -> None:
    owner = user_factory(username="inv_owner")
    alice = user_factory(username="inv_alice")
    matrix_client.service_is_admin = False
    community = create_community(client, bearer(owner, client)).json()
    assert community["membership"]["status"] == "invited"
    room = matrix_client.rooms[community["matrix_room_id"]]

    joined = client.post(f"/api/v1/channels/{community['id']}/join", headers=bearer(alice, client)).json()
    assert joined["membership"]["status"] == "invited"
    assert joined["member_count"] == 0
    assert room["members"][mxid(alice)] == "invite"

    room["members"][mxid(alice)] = "join"
    detail = client.get(f"/api/v1/channels/{community['id']}", headers=bearer(alice, client)).json()
    assert detail["membership"]["status"] == "joined"
    assert detail["member_count"] == 1


def test_reconciliation_follows_matrix_membership(
    client: ApiClient, user_factory, matrix_client: FakeMatrixClient
) -> None:
    owner = user_factory(username="rec_owner")
    alice = user_factory(username="rec_alice")
    owner_headers = bearer(owner, client)
    community = create_community(client, owner_headers).json()
    room = matrix_client.rooms[community["matrix_room_id"]]
    client.post(f"/api/v1/channels/{community['id']}/join", headers=bearer(alice, client))

    room["members"][mxid(alice)] = "leave"
    detail = client.get(f"/api/v1/channels/{community['id']}", headers=bearer(alice, client)).json()
    assert detail["membership"]["status"] == "left"
    assert detail["member_count"] == 1

    carol = user_factory(username="rec_carol")
    room["members"][mxid(carol)] = "join"
    members = client.get(f"/api/v1/channels/{community['id']}/members", headers=owner_headers).json()
    assert ("rec_carol", "member", "joined") in [(m["user"]["username"], m["role"], m["status"]) for m in members]


def test_owner_assigns_admins_and_roles_change_power_levels(
    client: ApiClient, user_factory, matrix_client: FakeMatrixClient
) -> None:
    owner = user_factory(username="role_owner")
    alice = user_factory(username="role_alice")
    bob = user_factory(username="role_bob")
    owner_headers = bearer(owner, client)
    alice_headers = bearer(alice, client)
    bob_headers = bearer(bob, client)
    community = create_community(client, owner_headers).json()
    room = matrix_client.rooms[community["matrix_room_id"]]
    client.post(f"/api/v1/channels/{community['id']}/join", headers=alice_headers)
    client.post(f"/api/v1/channels/{community['id']}/join", headers=bob_headers)

    role_url = lambda user: f"/api/v1/channels/{community['id']}/members/{user.id}/role"  # noqa: E731
    assert client.put(role_url(alice), headers=alice_headers, json={"role": "admin"}).status_code == 403
    assert client.put(role_url(alice), headers=alice_headers, json={"role": "owner"}).status_code == 422
    assert mxid(alice) not in room["users"]

    promoted = client.put(role_url(alice), headers=owner_headers, json={"role": "admin"})
    assert promoted.status_code == 200, promoted.text
    assert promoted.json()["role"] == "admin"
    assert room["users"][mxid(alice)] == CHANNEL_PUBLISHER_POWER_LEVEL
    alice_view = client.get(f"/api/v1/channels/{community['id']}", headers=alice_headers).json()
    assert alice_view["can_publish"] is True and alice_view["can_manage"] is True and alice_view["can_edit"] is False

    # Admins moderate members but cannot edit the community, assign roles or touch the owner.
    assert client.patch(f"/api/v1/channels/{community['id']}", headers=alice_headers, json={"description": "x"}).status_code == 403
    assert client.put(role_url(bob), headers=alice_headers, json={"role": "admin"}).status_code == 403
    assert client.delete(f"/api/v1/channels/{community['id']}/members/{owner.id}", headers=alice_headers).status_code == 403
    removed = client.delete(f"/api/v1/channels/{community['id']}/members/{bob.id}", headers=alice_headers)
    assert removed.status_code == 204
    assert room["members"][mxid(bob)] == "leave"
    assert client.get(f"/api/v1/channels/{community['id']}", headers=bob_headers).json()["membership"]["status"] == "removed"

    # The owner edits the community and demotes the admin again.
    edited = client.patch(f"/api/v1/channels/{community['id']}", headers=owner_headers, json={"description": "Updated"})
    assert edited.status_code == 200
    assert room["state"]["m.room.topic"] == {"topic": "Updated"}
    assert client.put(role_url(owner), headers=owner_headers, json={"role": "member"}).status_code == 400
    demoted = client.put(role_url(alice), headers=owner_headers, json={"role": "member"})
    assert demoted.status_code == 200
    assert mxid(alice) not in room["users"]

    # Application administrators keep owner-level rights everywhere.
    app_admin = user_factory(username="role_app_admin", role="admin")
    admin_headers = bearer(app_admin, client)
    assert client.patch(f"/api/v1/channels/{community['id']}", headers=admin_headers, json={"category": "technology"}).status_code == 200
    joined_admin = client.post(f"/api/v1/channels/{community['id']}/join", headers=admin_headers).json()
    assert joined_admin["membership"]["role"] == "admin" and joined_admin["can_publish"] is True


def test_matrix_failure_during_join_does_not_record_membership(
    client: ApiClient, user_factory, matrix_client: FakeMatrixClient
) -> None:
    owner = user_factory(username="fail_owner")
    alice = user_factory(username="fail_alice")
    community = create_community(client, bearer(owner, client)).json()
    matrix_client.fail_membership_changes = True
    response = client.post(f"/api/v1/channels/{community['id']}/join", headers=bearer(alice, client))
    assert response.status_code == 503
    detail = client.get(f"/api/v1/channels/{community['id']}", headers=bearer(alice, client)).json()
    assert detail["membership"] is None
    assert detail["member_count"] == 1


def test_archived_communities_disappear_and_members_are_removed(
    client: ApiClient, user_factory, matrix_client: FakeMatrixClient
) -> None:
    owner = user_factory(username="arch_owner")
    alice = user_factory(username="arch_alice")
    owner_headers = bearer(owner, client)
    community = create_community(client, owner_headers).json()
    client.post(f"/api/v1/channels/{community['id']}/join", headers=bearer(alice, client))
    room = matrix_client.rooms[community["matrix_room_id"]]

    assert client.delete(f"/api/v1/channels/{community['id']}", headers=bearer(alice, client)).status_code == 403
    assert client.delete(f"/api/v1/channels/{community['id']}", headers=owner_headers).status_code == 204
    assert room["members"][mxid(alice)] == "leave"
    assert client.get(f"/api/v1/channels/{community['id']}", headers=bearer(alice, client)).status_code == 404
    assert client.post(f"/api/v1/channels/{community['id']}/join", headers=bearer(alice, client)).status_code == 404
    assert client.get("/api/v1/channels", headers=owner_headers).json() == []


def test_community_validation(client: ApiClient, user_factory) -> None:
    creator = user_factory(username="val_creator")
    headers = bearer(creator, client)
    assert create_community(client, headers, name="A").status_code == 422
    assert create_community(client, headers, category="marketing").status_code == 422
    assert create_community(client, headers, category="gaming").status_code == 201
    assert create_community(client, headers, avatar_url="https://evil.example/x.png").status_code == 422
    assert create_community(client, headers, request_id="bad key!").status_code == 422
    assert create_community(client, headers, avatar_url="mxc://localhost/abc123").status_code == 201
