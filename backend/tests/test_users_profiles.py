from __future__ import annotations

from sqlalchemy.orm import Session

from app.core.config import settings
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


def test_me_profile_update_and_self_user_update(
    client: ApiClient,
    db_session: Session,
    user_factory,
) -> None:
    user = user_factory(username="profile_owner")
    headers = bearer(user, client)

    me = client.get("/api/v1/users/me", headers=headers)
    assert me.status_code == 200
    assert me.json()["email"] == user.email
    assert "password_hash" not in me.json()

    profile_update = client.patch(
        "/api/v1/profiles/me",
        headers=headers,
        json={
            "display_name": "Updated Display",
            "bio": "A short profile biography",
            "job_title": "Engineer",
            "organization": "Self-described organization",
        },
    )
    assert profile_update.status_code == 200
    assert profile_update.json()["display_name"] == "Updated Display"
    assert profile_update.json()["organization"] == "Self-described organization"

    account_update = client.patch(
        "/api/v1/users/me",
        headers=headers,
        json={"username": "profile_owner_new"},
    )
    assert account_update.status_code == 200
    assert account_update.json()["username"] == "profile_owner_new"
    db_session.refresh(user)
    assert db_session.get(User, user.id).username == "profile_owner_new"


def test_directory_search_is_case_insensitive_paginated_and_private(
    client: ApiClient,
    db_session: Session,
    user_factory,
) -> None:
    first = user_factory(username="directory_viewer")
    user_factory(username="AliceNorth")
    user_factory(username="AliceSouth")
    user_factory(username="BobOutside")
    headers = bearer(first, client)

    search = client.get(
        "/api/v1/users/search?q=ALICE&limit=1&offset=0",
        headers=headers,
    )
    next_page = client.get(
        "/api/v1/users/search?q=alice&limit=1&offset=1",
        headers=headers,
    )
    assert search.status_code == next_page.status_code == 200
    assert search.json()["total"] == 2
    assert len(search.json()["items"]) == 1
    assert search.json()["items"][0]["username"] != next_page.json()["items"][0]["username"]
    assert "email" not in search.text
    assert "password_hash" not in search.text

    outside_profile = client.get(
        f"/api/v1/profiles/{db_session.query(User).filter_by(username='boboutside').one().id}",
        headers=headers,
    )
    assert outside_profile.status_code == 404


def test_global_directory_excludes_the_current_user(
    client: ApiClient,
    user_factory,
) -> None:
    user = user_factory(username="unassigned_user")
    other = user_factory(username="another_unassigned_user")
    headers = bearer(user, client)

    own_search = client.get(
        "/api/v1/users/search?q=unassigned_user",
        headers=headers,
    )
    other_search = client.get(
        "/api/v1/users/search?q=another_unassigned_user",
        headers=headers,
    )
    assert own_search.status_code == other_search.status_code == 200
    assert own_search.json()["items"] == []
    assert [item["username"] for item in other_search.json()["items"]] == [
        "another_unassigned_user"
    ]


def test_directory_search_is_rate_limited_per_account(
    client: ApiClient,
    monkeypatch,
    user_factory,
) -> None:
    user = user_factory(username="limited_search_user")
    headers = bearer(user, client)
    monkeypatch.setattr(settings, "app_directory_rate_limit_attempts", 1)

    first = client.get("/api/v1/users/search?q=somebody", headers=headers)
    second = client.get("/api/v1/users/search?q=somebody", headers=headers)

    assert first.status_code == 200
    assert second.status_code == 429
    assert second.headers["retry-after"]


def test_search_includes_active_users_without_profiles_and_excludes_inactive_users(
    client: ApiClient,
    db_session: Session,
    user_factory,
) -> None:
    viewer = user_factory(username="profileless_search_viewer")
    profileless = user_factory(username="profileless_contact")
    inactive = user_factory(username="profileless_inactive_contact")
    db_session.delete(profileless.profile)
    inactive.is_active = False
    db_session.commit()
    headers = bearer(viewer, client)

    response = client.get(
        "/api/v1/users/search?q=profileless",
        headers=headers,
    )

    assert response.status_code == 200
    assert [item["username"] for item in response.json()["items"]] == [
        "profileless_contact"
    ]
    assert response.json()["items"][0]["profile"] is None


def test_other_users_cannot_be_patched_and_profile_errors_are_safe(
    client: ApiClient,
    user_factory,
) -> None:
    viewer = user_factory(username="viewer_user")
    subject = user_factory(username="subject_user")
    headers = bearer(viewer, client)

    response = client.patch(
        f"/api/v1/users/{subject.id}",
        headers=headers,
        json={"username": "takeover"},
    )
    assert response.status_code == 405
