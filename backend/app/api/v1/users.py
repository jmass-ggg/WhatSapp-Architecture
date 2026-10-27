from __future__ import annotations

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.api.dependencies import CurrentUser
from app.core.database import get_db
from app.core.permissions import require_feature
from app.core.rate_limit import limit_directory_search
from app.models.user import User
from app.schemas.user import UserDirectoryRead, UserMeRead, UserPage, UserPatch
from app.services.users import get_visible_user, search_users, update_user


router = APIRouter(prefix="/users", tags=["users"])
DirectoryUser = Annotated[User, Depends(require_feature("directory.search"))]


@router.get("/me", response_model=UserMeRead)
def read_me(
    current_user: CurrentUser,
    db: Annotated[Session, Depends(get_db)],
) -> User:
    return get_visible_user(db, current_user, current_user.id)


@router.patch("/me", response_model=UserMeRead)
def patch_me(
    payload: UserPatch,
    current_user: CurrentUser,
    db: Annotated[Session, Depends(get_db)],
) -> User:
    user = update_user(db, current_user, payload)
    return get_visible_user(db, user, user.id)


@router.get("/search", response_model=UserPage)
def search_directory(
    user: DirectoryUser,
    db: Annotated[Session, Depends(get_db)],
    q: Annotated[str, Query(min_length=2, max_length=32)],
    limit: Annotated[int, Query(ge=1, le=50)] = 20,
    offset: Annotated[int, Query(ge=0, le=10_000)] = 0,
) -> UserPage:
    query = q.strip()
    if len(query) < 2:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="Search query must contain at least two non-space characters",
        )
    limit_directory_search(str(user.id))
    items, total = search_users(db, user, query=query, limit=limit, offset=offset)
    return UserPage(
        items=[UserDirectoryRead.model_validate(item) for item in items],
        limit=limit,
        offset=offset,
        total=total,
    )


@router.get("/{user_id}", response_model=UserDirectoryRead)
def read_user(
    user_id: UUID,
    user: DirectoryUser,
    db: Annotated[Session, Depends(get_db)],
) -> User:
    return get_visible_user(db, user, user_id)
