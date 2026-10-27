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

from app.core.config import settings
from app.core.database import get_db
from app.core.rate_limit import login_rate_limiter
from app.core.security import hash_password
from app.main import create_app
from app.models.base import Base
from app.models.organization import Organization
from app.models.profile import Profile
from app.models.subscription import Subscription
from app.models.user import User
from tests.http_client import ApiClient


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
def client(test_engine: Engine, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(settings, "app_registration_enabled", True)
    login_rate_limiter.clear()
    factory = sessionmaker(bind=test_engine, autoflush=False, expire_on_commit=False)

    def override_get_db():
        with factory() as session:
            yield session

    application = create_app()
    application.dependency_overrides[get_db] = override_get_db
    with ApiClient(application) as test_client:
        yield test_client
    application.dependency_overrides.clear()


def create_test_user(
    db: Session,
    *,
    username: str | None = None,
    email: str | None = None,
    role: str = "user",
    organization_id=None,
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
        organization_id=organization_id,
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


@pytest.fixture
def organization_factory(db_session: Session):
    def create(name: str = "Example Organization") -> Organization:
        organization = Organization(
            name=name,
            slug=f"org-[redacted]{uuid4().hex[:12]}",
        )
        db_session.add(organization)
        db_session.commit()
        db_session.refresh(organization)
        return organization

    return create
