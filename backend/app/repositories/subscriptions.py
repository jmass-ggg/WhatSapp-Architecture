from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.subscription import Subscription


def get_latest_for_user(db: Session, user_id: UUID) -> Subscription | None:
    statement = (
        select(Subscription)
        .where(Subscription.user_id == user_id)
        .order_by(Subscription.created_at.desc(), Subscription.id.desc())
        .limit(1)
    )
    return db.scalar(statement)
