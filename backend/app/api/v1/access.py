from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.api.dependencies import CurrentUser
from app.core.database import get_db
from app.schemas.subscription import AccessDecision
from app.services.subscriptions import evaluate_feature_access


router = APIRouter(prefix="/access", tags=["access"])


@router.get("/check", response_model=AccessDecision)
def check_access(
    feature: Annotated[str, Query(min_length=1, max_length=80)],
    current_user: CurrentUser,
    db: Annotated[Session, Depends(get_db)],
) -> AccessDecision:
    return evaluate_feature_access(db, current_user, feature.strip())
