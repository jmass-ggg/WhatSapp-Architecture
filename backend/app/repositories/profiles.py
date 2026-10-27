from uuid import UUID

from sqlalchemy.orm import Session

from app.models.profile import Profile


def get_for_user(db: Session, user_id: UUID) -> Profile | None:
    return db.get(Profile, user_id)
