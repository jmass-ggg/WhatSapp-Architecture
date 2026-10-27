from collections.abc import Generator

from sqlalchemy import Engine, create_engine, text
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import settings


engine: Engine = create_engine(
    settings.database_url,
    pool_size=settings.app_database_pool_size,
    max_overflow=settings.app_database_max_overflow,
    pool_timeout=10,
    pool_recycle=1800,
    pool_pre_ping=True,
)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def get_db() -> Generator[Session, None, None]:
    with SessionLocal() as session:
        yield session


def check_database(session: Session) -> None:
    session.execute(text("SELECT 1"))
