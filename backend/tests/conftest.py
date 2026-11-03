from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

import pytest
from dotenv import load_dotenv
from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

load_dotenv(Path(__file__).resolve().parents[2] / ".env")

from app.api.dependencies import get_matrix_client
from app.core.config import settings
from app.core.database import get_db
from app.core.rate_limit import directory_search_rate_limiter, login_rate_limiter
from app.core.security import hash_password
from app.main import create_app
from app.integrations.matrix.client import MatrixConnectionError, MatrixSession
from app.models.base import Base
from app.models.profile import Profile
from app.models.subscription import Subscription
from app.models.user import User
from tests.http_client import ApiClient


class FakeMatrixClient:
    """In-memory stand-in for Synapse: sessions plus a minimal model of channel rooms."""

    service_user_id = f"@channels_service:{settings.synapse_server_name}"

    def __init__(self) -> None:
        self.login_requests: list[tuple[str, str]] = []
        self.logout_tokens: list[str] = []
        self.fail_login = False
        self.fail_logout = False
        # Channel room model: room_id -> {"members": {mxid: membership}, "users": {mxid: level},
        # "state": {event_type: content}, "name": str}
        self.rooms: dict[str, dict] = {}
        self.service_is_admin = True
        self.fail_create_room = False
        self.fail_membership_changes = False
        self.calls: list[tuple] = []

    # ---- channel rooms -------------------------------------------------------------
    def create_channel_room(self, *, channel_id, name, topic, category, avatar_url) -> str:
        if self.fail_create_room:
            raise MatrixConnectionError("Synapse is unavailable")
        room_id = f"!channel{len(self.rooms) + 1}:{settings.synapse_server_name}"
        self.rooms[room_id] = {
            "members": {self.service_user_id: "join"},
            "users": {},
            "name": name,
            "state": {
                "m.room.topic": {"topic": topic},
                "org.recruitable.chat.channel": {"channel_id": channel_id, "category": category},
                **({"m.room.avatar": {"url": avatar_url}} if avatar_url else {}),
            },
        }
        self.calls.append(("create_room", room_id))
        return room_id

    def _room(self, room_id: str) -> dict:
        if room_id not in self.rooms:
            raise MatrixConnectionError(f"unknown room {room_id}")
        return self.rooms[room_id]

    def room_membership(self, room_id, user_id):
        return self._room(room_id)["members"].get(user_id)

    def invite_user(self, room_id, user_id) -> None:
        if self.fail_membership_changes:
            raise MatrixConnectionError("Synapse is unavailable")
        members = self._room(room_id)["members"]
        if members.get(user_id) not in ("join", "invite"):
            members[user_id] = "invite"
        self.calls.append(("invite", room_id, user_id))

    def unban_user(self, room_id, user_id) -> None:
        self._room(room_id)["members"][user_id] = "leave"

    def kick_user(self, room_id, user_id, reason) -> None:
        if self.fail_membership_changes:
            raise MatrixConnectionError("Synapse is unavailable")
        members = self._room(room_id)["members"]
        if members.get(user_id) in ("join", "invite"):
            members[user_id] = "leave"
        self.calls.append(("kick", room_id, user_id))

    def force_join(self, room_id, user_id) -> bool:
        if self.fail_membership_changes:
            raise MatrixConnectionError("Synapse is unavailable")
        if not self.service_is_admin:
            return False
        self._room(room_id)["members"][user_id] = "join"
        self.calls.append(("join", room_id, user_id))
        return True

    def joined_members(self, room_id) -> set[str]:
        return {m for m, state in self._room(room_id)["members"].items() if state == "join"}

    def set_user_power_level(self, room_id, user_id, level) -> None:
        if self.fail_membership_changes:
            raise MatrixConnectionError("Synapse is unavailable")
        users = self._room(room_id)["users"]
        if level is None:
            users.pop(user_id, None)
        else:
            users[user_id] = level

    def set_room_state(self, room_id, event_type, content) -> None:
        room = self._room(room_id)
        if event_type == "m.room.name":
            room["name"] = content["name"]
        room["state"][event_type] = content

    def leave_room(self, room_id) -> None:
        self._room(room_id)["members"][self.service_user_id] = "leave"

    # ---- user sessions -------------------------------------------------------------

    def login_with_jwt(
        self,
        login_token: str,
        expected_user_id: str,
    ) -> MatrixSession:
        if self.fail_login:
            raise MatrixConnectionError("Synapse authentication is unavailable")
        self.login_requests.append((login_token, expected_user_id))
        return MatrixSession(
            access_token=f"matrix-{len(self.login_requests)}",
            user_id=expected_user_id,
            device_id=f"DEVICE{len(self.login_requests)}",
            home_server="localhost",
        )

    def logout(self, access_token: str) -> None:
        if self.fail_logout:
            raise MatrixConnectionError("Synapse logout is unavailable")
        self.logout_tokens.append(access_token)

    def session_is_valid(self, session: MatrixSession) -> bool:
        return session.access_token not in self.logout_tokens

    def health(self) -> dict[str, int | str]:
        return {"status": "ok", "supported_versions": 1}


@pytest.fixture
def test_engine() -> Engine:
    url = settings.test_database_url
    if url.database != "chat_app_test" or not str(url.database).endswith("_test"):
        raise RuntimeError("Tests are restricted to the dedicated chat_app_test database")

    engine = create_engine(url, pool_pre_ping=True)
    with engine.connect() as connection:
        database_name, is_superuser = connection.execute(
            text(
                "SELECT current_database(), rolsuper "
                "FROM pg_roles WHERE rolname = current_user"
            )
        ).one()
    if database_name != "chat_app_test" or is_superuser:
        engine.dispose()
        raise RuntimeError("Test database identity or role privileges are unsafe")

    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    try:
        yield engine
    finally:
        Base.metadata.drop_all(engine)
        engine.dispose()


@pytest.fixture
def db_session(test_engine: Engine):
    factory = sessionmaker(bind=test_engine, autoflush=False, expire_on_commit=False)
    with factory() as session:
        yield session


@pytest.fixture
def matrix_client() -> FakeMatrixClient:
    return FakeMatrixClient()


@pytest.fixture
def client(
    test_engine: Engine,
    monkeypatch: pytest.MonkeyPatch,
    matrix_client: FakeMatrixClient,
):
    monkeypatch.setattr(settings, "app_registration_enabled", True)
    login_rate_limiter.clear()
    directory_search_rate_limiter.clear()
    factory = sessionmaker(bind=test_engine, autoflush=False, expire_on_commit=False)

    def override_get_db():
        with factory() as session:
            yield session

    application = create_app()
    application.dependency_overrides[get_db] = override_get_db
    application.dependency_overrides[get_matrix_client] = lambda: matrix_client
    with ApiClient(application) as test_client:
        yield test_client
    application.dependency_overrides.clear()


def create_test_user(
    db: Session,
    *,
    username: str | None = None,
    email: str | None = None,
    role: str = "user",
    verified: bool = True,
    password: str = "Correct horse battery staple 17",
) -> User:
    suffix = uuid4().hex[:10]
    username = username or f"user_{suffix}"
    email = email or f"{username}@example.com"
    user = User(
        email=email.casefold(),
        username=username.casefold(),
        password_hash=hash_password(password),
        is_active=True,
        is_email_verified=verified,
        role=role,
    )
    profile = Profile(user=user, display_name=username.title())
    subscription = Subscription(
        user=user,
        plan_id="free",
        status="active",
        starts_at=datetime.now(UTC),
    )
    db.add_all((user, profile, subscription))
    db.commit()
    db.refresh(user)
    return user


@pytest.fixture
def user_factory(db_session: Session):
    def create(**kwargs) -> User:
        return create_test_user(db_session, **kwargs)

    return create
