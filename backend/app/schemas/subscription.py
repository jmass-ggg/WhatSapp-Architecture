from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator


PlanId = Literal["free", "pro", "enterprise"]
SubscriptionStatus = Literal["active", "canceled", "past_due", "paused", "expired", "scheduled"]


class SubscriptionRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID | None
    plan_id: PlanId
    status: SubscriptionStatus
    starts_at: datetime
    expires_at: datetime | None
    created_at: datetime


class SubscriptionPlanRead(BaseModel):
    id: PlanId
    label: str
    feature_entitlements: list[str]
    is_paid_placeholder: bool


class AccessDecision(BaseModel):
    feature: str
    allowed: bool
    effective_plan: PlanId
    reason: str


class SubscriptionGrantRequest(BaseModel):
    plan_id: PlanId
    status: Literal["active", "canceled", "past_due", "paused"] = "active"
    starts_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    expires_at: datetime | None = None

    @model_validator(mode="after")
    def validate_expiration(self) -> SubscriptionGrantRequest:
        if self.starts_at.tzinfo is None or self.starts_at.utcoffset() is None:
            raise ValueError("Subscription start must include a timezone")
        if (
            self.expires_at is not None
            and (self.expires_at.tzinfo is None or self.expires_at.utcoffset() is None)
        ):
            raise ValueError("Subscription expiration must include a timezone")
        if self.expires_at is not None and self.expires_at <= self.starts_at:
            raise ValueError("Expiration must be after the subscription start")
        return self
