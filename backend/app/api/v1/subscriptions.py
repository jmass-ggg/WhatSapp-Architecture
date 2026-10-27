from __future__ import annotations

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.dependencies import CurrentUser, require_roles
from app.core.database import get_db
from app.models.subscription import Subscription
from app.models.user import User
from app.schemas.subscription import (
    SubscriptionGrantRequest,
    SubscriptionPlanRead,
    SubscriptionRead,
)
from app.services.subscriptions import (
    get_my_subscription,
    grant_subscription,
    list_plans,
)


router = APIRouter(prefix="/subscriptions", tags=["subscriptions"])
AdminUser = Annotated[User, Depends(require_roles("admin"))]


@router.get("/plans", response_model=list[SubscriptionPlanRead])
def plans() -> list[SubscriptionPlanRead]:
    return list_plans()


@router.get("/me", response_model=SubscriptionRead)
def my_subscription(
    current_user: CurrentUser,
    db: Annotated[Session, Depends(get_db)],
) -> SubscriptionRead:
    return get_my_subscription(db, current_user)


@router.put("/{user_id}", response_model=SubscriptionRead, status_code=201)
def administer_subscription(
    user_id: UUID,
    payload: SubscriptionGrantRequest,
    admin: AdminUser,
    db: Annotated[Session, Depends(get_db)],
) -> Subscription:
    return grant_subscription(
        db,
        target_user_id=user_id,
        admin_user_id=admin.id,
        payload=payload,
    )
