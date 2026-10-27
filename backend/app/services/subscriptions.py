from __future__ import annotations

from datetime import UTC, datetime
from uuid import UUID

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.subscription import Subscription
from app.models.user import User
from app.repositories.subscriptions import get_latest_for_user
from app.schemas.subscription import (
    AccessDecision,
    PlanId,
    SubscriptionGrantRequest,
    SubscriptionPlanRead,
    SubscriptionRead,
)


_PLAN_LABELS: dict[PlanId, str] = {
    "free": "Free",
    "pro": "Pro (illustrative)",
    "enterprise": "Enterprise (illustrative)",
}


def _effective_plan(db: Session, user_id: UUID, now: datetime) -> tuple[PlanId, str]:
    subscription = get_latest_for_user(db, user_id)
    if subscription is None:
        return "free", "no_active_subscription"
    if subscription.starts_at > now:
        return "free", "subscription_not_started"
    if subscription.status != "active":
        return "free", "no_active_subscription"
    if subscription.expires_at is not None and subscription.expires_at <= now:
        return "free", "subscription_expired"
    return subscription.plan_id, "active_subscription"


def evaluate_feature_access(db: Session, user: User, feature: str) -> AccessDecision:
    now = datetime.now(UTC)
    plan, status_reason = _effective_plan(db, user.id, now)
    eligible_plans = settings.app_plan_entitlements.get(feature)
    if eligible_plans is None:
        return AccessDecision(
            feature=feature,
            allowed=False,
            effective_plan=plan,
            reason="unknown_feature",
        )

    allowed = plan in eligible_plans
    if allowed:
        reason = "allowed"
    elif status_reason != "active_subscription":
        reason = status_reason
    else:
        reason = "not_entitled"
    return AccessDecision(
        feature=feature,
        allowed=allowed,
        effective_plan=plan,
        reason=reason,
    )


def get_my_subscription(db: Session, user: User) -> SubscriptionRead:
    subscription = get_latest_for_user(db, user.id)
    now = datetime.now(UTC)
    if subscription is None:
        return SubscriptionRead(
            id=None,
            plan_id="free",
            status="active",
            starts_at=now,
            expires_at=None,
            created_at=now,
        )

    if subscription.status == "active" and subscription.starts_at > now:
        displayed_status = "scheduled"
    elif (
        subscription.status == "active"
        and subscription.expires_at is not None
        and subscription.expires_at <= now
    ):
        displayed_status = "expired"
    else:
        displayed_status = subscription.status
    return SubscriptionRead(
        id=subscription.id,
        plan_id=subscription.plan_id,
        status=displayed_status,
        starts_at=subscription.starts_at,
        expires_at=subscription.expires_at,
        created_at=subscription.created_at,
    )


def list_plans() -> list[SubscriptionPlanRead]:
    plan_ids: tuple[PlanId, ...] = ("free", "pro", "enterprise")
    return [
        SubscriptionPlanRead(
            id=plan_id,
            label=_PLAN_LABELS[plan_id],
            feature_entitlements=sorted(
                feature
                for feature, eligible_plans in settings.app_plan_entitlements.items()
                if plan_id in eligible_plans
            ),
            is_paid_placeholder=plan_id != "free",
        )
        for plan_id in plan_ids
    ]


def grant_subscription(
    db: Session,
    *,
    target_user_id: UUID,
    admin_user_id: UUID,
    payload: SubscriptionGrantRequest,
) -> Subscription:
    target = db.get(User, target_user_id)
    if target is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")

    now = datetime.now(UTC)
    active_records = db.scalars(
        select(Subscription)
        .where(
            Subscription.user_id == target_user_id,
            Subscription.status == "active",
        )
        .with_for_update()
    )
    for existing in active_records:
        existing.status = "canceled"

    subscription = Subscription(
        user_id=target_user_id,
        plan_id=payload.plan_id,
        status=payload.status,
        starts_at=payload.starts_at,
        expires_at=payload.expires_at,
        created_by_user_id=admin_user_id,
    )
    db.add(subscription)
    db.commit()
    db.refresh(subscription)
    return subscription
